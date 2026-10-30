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
//   - Quellen: auto (ERP-Lauf/Knopf), manual (von Hand hochgeladen), bexio
//     (Lohnabrechnung aus Bexio über Trust flow, ab Lohnmonat Dezember 2026).
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

// ---------------------------------------------------------------------------
// Lohnabrechnung aus Bexio (über Trust flow, POST /api/flow/lohnabrechnung)
// ---------------------------------------------------------------------------

export interface BexioFassungInput {
  profileId: string;
  jahr: number;
  monat: number;
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
 *  nur Lohnmonate nach lauf_bis, gleiche Fassung = vorhanden, ältere = abgelehnt).
 *  Ausser bei einer neuen Fassung ist die eben hochgeladene Datei danach wieder weg. */
export async function speichereBexioFassung(admin: SupabaseClient, i: BexioFassungInput): Promise<BexioFassungErgebnis> {
  const version = await naechsteVersion(admin, {
    profileId: i.profileId, docType: "lohnabrechnung", year: i.jahr, month: i.monat,
    pdf: i.pdf, source: "manual", actorId: null, actorName: null,
  });
  const pfad = fassungsPfad({
    profileId: i.profileId, docType: "lohnabrechnung", year: i.jahr, month: i.monat, version,
    jetzt: i.jetzt ?? new Date(), zufall: i.zufall ?? randomBytes(3).toString("hex"),
  });
  const { error: upErr } = await admin.storage.from(LOHN_BUCKET).upload(pfad, i.pdf, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new LohnFehler(`PDF konnte nicht gespeichert werden: ${upErr.message}`);

  const { data, error } = await admin.rpc("lohn_bexio_fassung_speichern", {
    p_profile_id: i.profileId,
    p_jahr: i.jahr,
    p_monat: i.monat,
    p_fassung: i.fassung,
    p_pdf_sha256: i.pdfSha256,
    p_storage_path: pfad,
    p_file_size: i.pdf.byteLength,
    p_flow_abruf_id: i.flowAbrufId,
    p_flow_sub: i.flowSub,
  });
  if (error || !data) {
    const aufraeumFehler = await entferneEigeneDatei(admin, pfad);
    throw new LohnFehler(
      `Lohnabrechnung aus Bexio konnte nicht gespeichert werden: ${error?.message ?? "keine Antwort"}` +
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

// ---------------------------------------------------------------------------
// Phase 2: Fassung MIT Momentaufnahme (Eingaben, Positionen, Prüfsumme)
// ---------------------------------------------------------------------------

export type MomentaufnahmeArt = "regulaer" | "korrektur";

export interface MomentaufnahmeInput {
  profileId: string;
  jahr: number;
  monat: number;
  art: MomentaufnahmeArt;
  pdf: Uint8Array;
  pdfSha256: string;
  actorId: string | null;
  actorName: string | null;
  /** Lauf: nur speichern, wenn es noch keine gültige Fassung gibt. */
  nurWennKeineGueltige: boolean;
  auszahlungsdatum: string;
  kernVersion: string;
  eingaben: unknown;
  ergebnis: unknown;
  pruefsumme: string;
  werte: {
    brutto: number;
    total_abzuege: number;
    netto: number;
    /** Phase 4: Netto + Spesen (Auszahlung der Fassung). */
    auszahlungsbetrag: number;
    ahv_lohn: number;
    alv_lohn: number;
    uvg_lohn: number;
    uvg_art: "bu" | "bu_nbu";
    quellensteuer: number;
  };
  begruendung: string | null;
  /** Vom PDF erwartete Auszahlung (Korrektur: Differenz) — muss zur DB passen. */
  erwarteteAuszahlung: number;
  jetzt?: Date;
  zufall?: string;
}

export interface MomentaufnahmeErgebnis extends FassungErgebnis {
  momentaufnahmeId: string | null;
  fassung: number | null;
  auszahlung: number | null;
}

/** PDF unter eigenem Pfad ablegen, dann PDF-Zeile + Momentaufnahme in EINER
 *  DB-Transaktion (RPC lohn_momentaufnahme_speichern). Jeder Fehler danach
 *  entfernt genau die eben hochgeladene Datei. */
export async function speichereMomentaufnahme(admin: SupabaseClient, i: MomentaufnahmeInput): Promise<MomentaufnahmeErgebnis> {
  const version = await naechsteVersion(admin, {
    profileId: i.profileId, docType: "lohnabrechnung", year: i.jahr, month: i.monat,
    pdf: i.pdf, source: "auto", actorId: i.actorId, actorName: i.actorName,
  });
  const pfad = fassungsPfad({
    profileId: i.profileId, docType: "lohnabrechnung", year: i.jahr, month: i.monat, version,
    jetzt: i.jetzt ?? new Date(), zufall: i.zufall ?? randomBytes(3).toString("hex"),
  });
  const { error: upErr } = await admin.storage.from(LOHN_BUCKET).upload(pfad, i.pdf, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new LohnFehler(`PDF konnte nicht gespeichert werden: ${upErr.message}`);

  const { data, error } = await admin.rpc("lohn_momentaufnahme_speichern", {
    p_profile_id: i.profileId,
    p_jahr: i.jahr,
    p_monat: i.monat,
    p_art: i.art,
    p_storage_path: pfad,
    p_file_size: i.pdf.byteLength,
    p_pdf_sha256: i.pdfSha256,
    p_actor: i.actorId,
    p_actor_name: i.actorName,
    p_nur_wenn_keine_gueltige: i.nurWennKeineGueltige,
    p_auszahlungsdatum: i.auszahlungsdatum,
    p_geschaetzt: false,
    p_kern_version: i.kernVersion,
    p_eingaben: i.eingaben,
    p_ergebnis: i.ergebnis,
    p_pruefsumme: i.pruefsumme,
    p_werte: i.werte,
    p_begruendung: i.begruendung,
    p_wage_document_id: null,
  });
  if (error || !data) {
    const aufraeumFehler = await entferneEigeneDatei(admin, pfad);
    throw new LohnFehler(
      `Lohnabrechnung konnte nicht gespeichert werden: ${error?.message ?? "keine Antwort"}` +
        (aufraeumFehler ? ` — zusätzlich verwaiste Datei ${pfad} (${aufraeumFehler})` : ""),
      error && /Altbestand|Korrekturfassung|schon eine Fassung/.test(error.message) ? 409 : 500,
    );
  }
  const r = data as { modus: FassungErgebnis["modus"]; id?: string; version?: number; vorherige_version?: number | null; momentaufnahme_id?: string; fassung?: number; auszahlung?: number | string };
  if (r.modus === "vorhanden") {
    await entferneEigeneDatei(admin, pfad);
    return { modus: "vorhanden", id: r.id ?? "", version: r.version ?? 0, vorherigeVersion: null, pfad: null, momentaufnahmeId: null, fassung: null, auszahlung: null };
  }
  const auszahlung = Number(r.auszahlung);
  if (Math.abs(auszahlung - i.erwarteteAuszahlung) > 0.004) {
    // Zwischen Rechnen und Speichern kam eine andere Fassung dazu: die PDF
    // nennt einen falschen Betrag. Die Zeile ist gespeichert (nie löschen) —
    // laut melden, damit eine neue Korrekturfassung entsteht.
    throw new LohnFehler(
      `Gleichzeitige Fassung: PDF nennt CHF ${i.erwarteteAuszahlung.toFixed(2)}, gespeichert ist CHF ${auszahlung.toFixed(2)} — bitte neue Korrekturfassung erzeugen`,
      409,
    );
  }
  return {
    modus: r.modus, id: r.id ?? "", version: r.version ?? 0, vorherigeVersion: r.vorherige_version ?? null, pfad,
    momentaufnahmeId: r.momentaufnahme_id ?? null, fassung: r.fassung ?? null, auszahlung,
  };
}
