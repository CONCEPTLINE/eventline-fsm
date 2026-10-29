// Lohn-Fassungen speichern (Phase 1): PDF + Datenbankzeile gemeinsam.
//
// Regeln:
//   - Nie überschreiben: jede Fassung bekommt einen EIGENEN Speicherpfad
//       <profil>/<jahr>/<YYYY-MM | lohnausweis>/v<n>-<zeitstempel>-<zufall>.pdf
//     und wird mit upsert:false hochgeladen. Bestehende Dateien bleiben.
//   - PDF und Zeile gemeinsam: erst Datei, dann Zeile + Protokoll in EINER
//     DB-Transaktion (RPC lohn_fassung_speichern). Scheitert die Zeile, wird
//     genau die eben hochgeladene Datei wieder entfernt — keine PDF ohne Zeile,
//     keine Zeile ohne PDF.
//   - Diese Datei ist die EINZIGE Stelle, die im Bucket «lohndokumente» etwas
//     entfernt (nur die eigene, eben hochgeladene, noch unverknüpfte Datei).
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

export interface FassungInput {
  profileId: string;
  docType: DocType;
  year: number;
  month: number | null;
  pdf: Uint8Array;
  source: "auto" | "manual";
  actorId: string | null;
  actorName: string | null;
  notes?: string | null;
  /** true = nur speichern, wenn es noch keine gültige Fassung gibt (Lauf). */
  nurWennKeineGueltige?: boolean;
  details?: Record<string, unknown>;
  /** Für Tests: fester Zeitpunkt/Zufall im Pfad. */
  jetzt?: Date;
  zufall?: string;
}

export interface FassungErgebnis {
  modus: "neu" | "neue_fassung" | "ersetzt" | "vorhanden";
  id: string;
  version: number;
  vorherigeVersion: number | null;
  pfad: string | null;
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

/** Gültige Fassung (nicht im Papierkorb, nicht ersetzt) dieser Periode. */
export async function ladeGueltigeFassung(
  admin: SupabaseClient,
  profileId: string,
  docType: DocType,
  year: number,
  month: number | null,
): Promise<{ id: string; version: number; source: string | null; uploaded_at: string } | null> {
  let q = admin
    .from("wage_documents")
    .select("id, version, source, uploaded_at")
    .eq("profile_id", profileId)
    .eq("doc_type", docType)
    .eq("year", year)
    .is("archived_at", null)
    .is("superseded_at", null)
    .order("version", { ascending: false })
    .limit(1);
  q = month == null ? q.is("period_month", null) : q.eq("period_month", month);
  const { data, error } = await q.maybeSingle();
  if (error) throw new LohnFehler(`Lohndokumente konnten nicht geladen werden: ${error.message}`);
  return (data as { id: string; version: number; source: string | null; uploaded_at: string } | null) ?? null;
}

/** Liegt für die Periode eine Fassung im Papierkorb (und keine gültige)?
 *  Dann fragt die UI vor einer neuen Fassung nach, und der Lauf erzeugt
 *  nichts (jemand hat sie bewusst weggelegt). */
export async function ladeArchivierteFassung(
  admin: SupabaseClient,
  profileId: string,
  docType: DocType,
  year: number,
  month: number | null,
): Promise<{ id: string; version: number } | null> {
  let q = admin
    .from("wage_documents")
    .select("id, version")
    .eq("profile_id", profileId)
    .eq("doc_type", docType)
    .eq("year", year)
    .not("archived_at", "is", null)
    .is("superseded_at", null)
    .order("version", { ascending: false })
    .limit(1);
  q = month == null ? q.is("period_month", null) : q.eq("period_month", month);
  const { data, error } = await q.maybeSingle();
  if (error) throw new LohnFehler(`Lohndokumente konnten nicht geladen werden: ${error.message}`);
  return (data as { id: string; version: number } | null) ?? null;
}

/** Vier Augen: eigene Lohndokumente erzeugt, lädt hoch oder legt weg nur
 *  der andere Admin bzw. die Vertretung (der automatische Lauf ist davon
 *  nicht betroffen — er hat keinen Benutzer). */
export const EIGENE_DOKUMENTE_VERBOTEN =
  "Eigene Lohndokumente bearbeitet der andere Admin oder die Vertretung (Vier-Augen-Prinzip).";

async function naechsteVersion(admin: SupabaseClient, i: FassungInput): Promise<number> {
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

/** PDF unter eigenem Pfad ablegen und Zeile + Protokoll speichern. Wirft
 *  LohnFehler; bei jedem Fehler nach dem Hochladen ist die Datei wieder weg
 *  (oder der Fehlertext nennt die verwaiste Datei). */
export async function speichereFassung(admin: SupabaseClient, i: FassungInput): Promise<FassungErgebnis> {
  const version = await naechsteVersion(admin, i);
  const pfad = fassungsPfad({
    profileId: i.profileId,
    docType: i.docType,
    year: i.year,
    month: i.month,
    version,
    jetzt: i.jetzt ?? new Date(),
    zufall: i.zufall ?? randomBytes(3).toString("hex"),
  });

  const { error: upErr } = await admin.storage.from(LOHN_BUCKET).upload(pfad, i.pdf, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (upErr) throw new LohnFehler(`PDF konnte nicht gespeichert werden: ${upErr.message}`);

  const { data, error: rpcErr } = await admin.rpc("lohn_fassung_speichern", {
    p_profile_id: i.profileId,
    p_doc_type: i.docType,
    p_year: i.year,
    p_period_month: i.month,
    p_storage_path: pfad,
    p_file_size: i.pdf.byteLength,
    p_source: i.source,
    p_actor: i.actorId,
    p_actor_name: i.actorName,
    p_notes: i.notes ?? null,
    p_nur_wenn_keine_gueltige: i.nurWennKeineGueltige === true,
    p_details: i.details ?? {},
  });
  if (rpcErr || !data) {
    const aufraeumFehler = await entferneEigeneDatei(admin, pfad);
    throw new LohnFehler(
      `Lohndokument konnte nicht gespeichert werden: ${rpcErr?.message ?? "keine Antwort"}` +
        (aufraeumFehler ? ` — zusätzlich verwaiste Datei ${pfad} (${aufraeumFehler})` : ""),
    );
  }

  const r = data as { modus: FassungErgebnis["modus"]; id: string; version: number; vorherige_version?: number | null };
  if (r.modus === "vorhanden") {
    // Inzwischen hat ein anderer Aufruf eine gültige Fassung gespeichert:
    // eigene Datei wieder weg, nichts überschrieben.
    await entferneEigeneDatei(admin, pfad);
    return { modus: "vorhanden", id: r.id, version: r.version, vorherigeVersion: null, pfad: null };
  }
  return { modus: r.modus, id: r.id, version: r.version, vorherigeVersion: r.vorherige_version ?? null, pfad };
}
