// Lohndokumente aus Trust flow speichern: PDF + Datenbankzeile gemeinsam.
//
// Regeln:
//   - Nie überschreiben: jede Fassung bekommt einen EIGENEN Speicherpfad
//       <profil>/<jahr>/<YYYY-MM | lohnausweis>/v<n>-<zeitstempel>-<zufall>.pdf
//     und wird mit upsert:false hochgeladen. Bestehende Dateien bleiben.
//   - PDF und Zeile gemeinsam: erst Datei, dann Zeile + Protokoll in EINER
//     DB-Transaktion (RPC lohn_bexio_fassung_speichern / lohn_bexio_ausweis_speichern,
//     beide über lohn_fassung_speichern). Scheitert die Zeile, wird
//     genau die eben hochgeladene Datei wieder entfernt — keine PDF ohne Zeile,
//     keine Zeile ohne PDF.
//   - Diese Datei ist die EINZIGE Stelle, die im Bucket «lohndokumente» etwas
//     entfernt (nur die eigene, eben hochgeladene, noch unverknüpfte Datei).
//   - Neue Dokumente kommen nur noch aus Trust flow (Quelle «bexio», ab Lohnmonat
//     November 2026; Lohn-Abbau 11.11.2026). Ältere Fassungen (auto/manual aus dem
//     ERP-Lohnlauf bis Oktober 2026) bleiben unverändert erhalten.
//     Test: src/lib/lohn/fassung.test.ts («kein anderer Code löscht»).

import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";
import { logError } from "@/lib/log";

export const LOHN_BUCKET = "lohndokumente";

export type DocType = "lohnabrechnung" | "lohnausweis";

/** Fehler mit HTTP-Status für die Routen. */
export class LohnFehler extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 500, code?: string) {
    super(message);
    this.name = "LohnFehler";
    this.status = status;
    this.code = code;
  }
}

/** Periode eines Lohndokuments (Lohnabrechnung je Monat, Lohnausweis je Jahr). */
interface Periode {
  profileId: string;
  docType: DocType;
  year: number;
  month: number | null;
}

function periodeOrdner(docType: DocType, year: number, month: number | null): string {
  if (docType === "lohnabrechnung") {
    if (!month) throw new LohnFehler("Monat fehlt für Lohnabrechnung", 400);
    return `${year}-${String(month).padStart(2, "0")}`;
  }
  return "lohnausweis";
}

/** Speicherpfad einer Fassung — nie zweimal derselbe. */
export function fassungsPfad(args: {
  profileId: string;
  docType: DocType;
  year: number;
  month: number | null;
  version: number;
  jetzt: Date;
  zufall: string;
}): string {
  const stempel = args.jetzt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20261029T091502Z
  return `${args.profileId}/${args.year}/${periodeOrdner(args.docType, args.year, args.month)}/v${args.version}-${stempel}-${args.zufall}.pdf`;
}

/** Vier Augen: eigene Lohndokumente öffnet über den Verwaltungsweg nur
 *  der andere Admin bzw. die Vertretung. */
export const EIGENE_DOKUMENTE_VERBOTEN =
  "Eigene Lohndokumente bearbeitet der andere Admin oder die Vertretung (Vier-Augen-Prinzip).";

async function naechsteVersion(admin: SupabaseClient, i: Periode): Promise<number> {
  let q = admin
    .from("wage_documents")
    .select("version")
    .eq("profile_id", i.profileId)
    .eq("doc_type", i.docType)
    .eq("year", i.year)
    .order("version", { ascending: false })
    .limit(1);
  q = i.month == null ? q.is("period_month", null) : q.eq("period_month", i.month);
  const { data, error } = await q.maybeSingle();
  if (error) throw new LohnFehler(`Lohndokumente konnten nicht geladen werden: ${error.message}`);
  return Number((data as { version?: number } | null)?.version ?? 0) + 1;
}

async function entferneEigeneDatei(admin: SupabaseClient, pfad: string): Promise<string | null> {
  const { error } = await admin.storage.from(LOHN_BUCKET).remove([pfad]);
  if (error) {
    logError("lohn.fassung.aufraeumen", error, { pfad });
    return error.message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lohnabrechnung / Lohnausweis aus Trust flow (POST /api/flow/lohnabrechnung)
// ---------------------------------------------------------------------------

export interface BexioFassungInput {
  profileId: string;
  /** Lohnabrechnung (je Lohnmonat, Vorgabe) oder Lohnausweis (je Jahr, monat null; Migration 377). */
  docType?: DocType;
  jahr: number;
  monat: number | null;
  /** Fassung laut Trust flow/Bexio. */
  fassung: number;
  pdf: Uint8Array;
  pdfSha256: string;
  flowAbrufId: string;
  flowSub: string;
  jetzt?: Date;
  zufall?: string;
}

export type BexioFassungErgebnis =
  | { modus: "neu" | "neue_fassung" | "ersetzt" | "vorhanden"; id: string; version: number }
  | { modus: "abgelehnt"; code: string; meldung: string };

/** PDF aus Bexio unter eigenem Pfad ablegen, dann Zeile + Protokoll + Zuordnung
 *  zur Bexio-Fassung in EINER Transaktion (RPC lohn_bexio_fassung_speichern:
 *  nur Lohnmonate nach lauf_bis; Lohnausweis: lohn_bexio_ausweis_speichern, je Jahr;
 *  gleiche Fassung = vorhanden, ältere = abgelehnt).
 *  Ausser bei einer neuen Fassung ist die eben hochgeladene Datei danach wieder weg. */
export async function speichereBexioFassung(admin: SupabaseClient, i: BexioFassungInput): Promise<BexioFassungErgebnis> {
  const docType: DocType = i.docType ?? "lohnabrechnung";
  const monat = docType === "lohnausweis" ? null : i.monat;
  const version = await naechsteVersion(admin, { profileId: i.profileId, docType, year: i.jahr, month: monat });
  const pfad = fassungsPfad({
    profileId: i.profileId, docType, year: i.jahr, month: monat, version,
    jetzt: i.jetzt ?? new Date(), zufall: i.zufall ?? randomBytes(3).toString("hex"),
  });
  const { error: upErr } = await admin.storage.from(LOHN_BUCKET).upload(pfad, i.pdf, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new LohnFehler(`PDF konnte nicht gespeichert werden: ${upErr.message}`);

  const gemeinsam = {
    p_profile_id: i.profileId,
    p_jahr: i.jahr,
    p_fassung: i.fassung,
    p_pdf_sha256: i.pdfSha256,
    p_storage_path: pfad,
    p_file_size: i.pdf.byteLength,
    p_flow_abruf_id: i.flowAbrufId,
    p_flow_sub: i.flowSub,
  };
  const { data, error } = docType === "lohnausweis"
    ? await admin.rpc("lohn_bexio_ausweis_speichern", gemeinsam)
    : await admin.rpc("lohn_bexio_fassung_speichern", { ...gemeinsam, p_monat: monat });
  if (error || !data) {
    const aufraeumFehler = await entferneEigeneDatei(admin, pfad);
    throw new LohnFehler(
      `${docType === "lohnausweis" ? "Lohnausweis" : "Lohnabrechnung"} aus Bexio konnte nicht gespeichert werden: ${error?.message ?? "keine Antwort"}` +
        (aufraeumFehler ? ` — zusätzlich verwaiste Datei ${pfad} (${aufraeumFehler})` : ""),
    );
  }
  const r = data as { modus: string; id?: string; version?: number; code?: string; meldung?: string };
  if (r.modus === "abgelehnt" || r.modus === "vorhanden") {
    await entferneEigeneDatei(admin, pfad);
    return r.modus === "abgelehnt"
      ? { modus: "abgelehnt", code: r.code ?? "abgelehnt", meldung: r.meldung ?? "Abgelehnt." }
      : { modus: "vorhanden", id: r.id ?? "", version: Number(r.version ?? 0) };
  }
  return { modus: r.modus as "neu" | "neue_fassung" | "ersetzt", id: r.id ?? "", version: Number(r.version ?? 0) };
}
