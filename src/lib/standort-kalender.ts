// Standort-Kalender — EIN Kalender pro Standort mit eigenen Terminen des
// Standorts (standort_termine, Migration 382), Partner-Anfragen und den
// EVENTLINE-Auftraegen am Standort. Gezeigt im Partnerportal (Belegungsplan,
// /api/partner/belegungsplan) und intern pro Standort
// (/api/standorte/[id]/belegungsplan).
//
// Freigeschaltet nur fuer Standorte mit locations.partner_kalender = true
// (vorerst Barakuba). Ohne Schalter bleibt das Partnerportal wie bisher:
// eigene Anfragen mit Details, alles andere nur «belegt» (Leo 2026-10-15).
//
// Reine Regeln + kleine Lade-Helfer, die einen Supabase-Client bekommen
// (Partner: Admin-Client nach requirePartnerPortal; intern: RLS-Client des
// Nutzers). Typen und kalenderTerminPruefen nutzt auch das UI.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  istEigeneAnfrage,
  istIsoZeitpunkt,
  zugewieseneNamen,
  type AnfrageKern,
  type PartnerStandort,
} from "@/lib/partner-anfrage";
import { isUuid } from "@/lib/search-escape";

export type KalenderArt = "termin" | "anfrage" | "auftrag" | "belegt";

export interface KalenderEintrag {
  /** termin: standort_termine.id; anfrage/auftrag: Job-ID; belegt: "belegt-<n>" */
  id: string;
  /** termin = eigener Eintrag des Standorts; anfrage = Partner-Anfrage;
   *  auftrag = EVENTLINE-Auftrag; belegt = fremd ohne Details (nur
   *  Partnersicht an Standorten ohne partner_kalender). */
  art: KalenderArt;
  titel: string;
  kunde: string | null;
  /** jobs.status bei anfrage/auftrag, sonst null */
  status: string | null;
  /** ISO timestamptz */
  start: string;
  ende: string | null;
  ganztaegig: boolean;
  /** nur termin */
  notiz: string | null;
  /** Namen zugeteilter EVENTLINE-Leute (anfrage/auftrag), sonst [] */
  zugewiesen: string[];
  /** Partnersicht: /partner/anfragen/<id> nur bei anfrage; intern:
   *  /auftraege/<id> bei anfrage/auftrag; termin/belegt: null */
  link: string | null;
  /** true nur bei termin und wenn der Aufrufer schreiben darf */
  bearbeitbar: boolean;
}

export interface TerminEingabeKalender {
  titel: string;
  kunde: string | null;
  start: string;
  ende: string | null;
  ganztaegig: boolean;
  notiz: string | null;
}

/** Grenzen wie die CHECKs in Migration 382. */
export const KALENDER_TITEL_MAX = 200;
export const KALENDER_KUNDE_MAX = 200;
export const KALENDER_NOTIZ_MAX = 2000;

/**
 * Eingabe eines eigenen Standort-Termins pruefen: Titel Pflicht (getrimmt,
 * hoechstens 200 Zeichen), Kunde optional (200), Beginn ISO mit Zeitzone,
 * Ende optional und nicht vor dem Beginn, ganztaegig boolean, Notiz 2000.
 * Ganztaegig schickt der Client Beginn = Zuercher 00:00 des ersten Tags und
 * Ende = Zuercher 23:59 des letzten Tags (oder null = ein Tag).
 */
export function kalenderTerminPruefen(
  roh: unknown,
): { ok: true; termin: TerminEingabeKalender } | { ok: false; fehler: string } {
  const b = (roh && typeof roh === "object" ? roh : {}) as Record<string, unknown>;

  const titel = typeof b.titel === "string" ? b.titel.trim() : "";
  if (!titel) return { ok: false, fehler: "Titel fehlt" };
  if (titel.length > KALENDER_TITEL_MAX) {
    return { ok: false, fehler: `Titel ist zu lang (höchstens ${KALENDER_TITEL_MAX} Zeichen)` };
  }

  if (b.kunde != null && typeof b.kunde !== "string") return { ok: false, fehler: "Ungültiger Kunde" };
  const kunde = typeof b.kunde === "string" ? b.kunde.trim() : "";
  if (kunde.length > KALENDER_KUNDE_MAX) {
    return { ok: false, fehler: `Kunde ist zu lang (höchstens ${KALENDER_KUNDE_MAX} Zeichen)` };
  }

  if (!istIsoZeitpunkt(b.start)) return { ok: false, fehler: "Beginn fehlt oder ist ungültig" };
  let ende: string | null = null;
  if (b.ende != null && b.ende !== "") {
    if (!istIsoZeitpunkt(b.ende)) return { ok: false, fehler: "Ungültiges Ende" };
    if (Date.parse(b.ende) < Date.parse(b.start)) return { ok: false, fehler: "Ende liegt vor dem Beginn" };
    ende = b.ende;
  }

  if (b.ganztaegig != null && typeof b.ganztaegig !== "boolean") {
    return { ok: false, fehler: "Ungültige Angabe «ganztägig»" };
  }

  if (b.notiz != null && typeof b.notiz !== "string") return { ok: false, fehler: "Ungültige Notiz" };
  const notiz = typeof b.notiz === "string" ? b.notiz.trim() : "";
  if (notiz.length > KALENDER_NOTIZ_MAX) {
    return { ok: false, fehler: `Notiz ist zu lang (höchstens ${KALENDER_NOTIZ_MAX} Zeichen)` };
  }

  return {
    ok: true,
    termin: {
      titel,
      kunde: kunde || null,
      start: b.start,
      ende,
      ganztaegig: b.ganztaegig === true,
      notiz: notiz || null,
    },
  };
}

// ─── Zeitraum ────────────────────────────────────────────────────────────────

const ISO_DATUM_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** start/end der Kalender-Abfrage — landen in .or()-Filtern, deshalb nur
 *  echte ISO-Daten (Datum oder Zeitpunkt) zulassen. */
export function istIsoDatum(v: unknown): v is string {
  return typeof v === "string" && ISO_DATUM_RE.test(v) && !Number.isNaN(Date.parse(v));
}

// ─── Daten aus der DB ────────────────────────────────────────────────────────

/** Job-Zeile des Kalenders (Spalten JOB_SPALTEN). */
export interface KalenderJob extends AnfrageKern {
  id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  contact_person: string | null;
  customer: { name: string | null } | null;
}

export interface StandortTerminZeile {
  id: string;
  titel: string;
  kunde: string | null;
  start_at: string;
  end_at: string | null;
  ganztaegig: boolean;
  notiz: string | null;
}

export type Zuteilung = { job_id: string; assigned_to: string | null };

const JOB_SPALTEN =
  "id, title, status, start_date, end_date, location_id, is_deleted, accepted_at, rejected_at, created_by, contact_person, customer:customers(name)";
const TERMIN_SPALTEN = "id, titel, kunde, start_at, end_at, ganztaegig, notiz";

/** Auftraege am Standort im Zeitraum: beginnt vor dem Ende UND endet im/nach
 *  dem Anfang (mehrtaegige Events, die vorher begannen, bleiben drin).
 *  Ohne geloeschte und ohne Datum. Wirft bei DB-Fehler. */
export async function kalenderJobsLaden(
  db: SupabaseClient,
  standortId: string,
  start: string,
  end: string,
): Promise<KalenderJob[]> {
  const { data, error } = await db
    .from("jobs")
    .select(JOB_SPALTEN)
    .eq("location_id", standortId)
    .not("is_deleted", "is", true)
    .not("start_date", "is", null)
    .or(`and(start_date.lt.${end},or(end_date.gte.${start},and(end_date.is.null,start_date.gte.${start})))`)
    .order("start_date");
  if (error) throw error;
  // PostgREST liefert eine n:1-Relation als Objekt (Typen sagen Array).
  return ((data ?? []) as unknown[]).map((roh) => {
    const j = roh as KalenderJob & { customer: unknown };
    const c = Array.isArray(j.customer) ? j.customer[0] : j.customer;
    return { ...j, customer: (c as { name: string | null } | null | undefined) ?? null };
  });
}

/** Eigene Termine des Standorts im Zeitraum (gleiche Ueberlappungs-Regel). */
export async function kalenderTermineLaden(
  db: SupabaseClient,
  standortId: string,
  start: string,
  end: string,
): Promise<StandortTerminZeile[]> {
  const { data, error } = await db
    .from("standort_termine")
    .select(TERMIN_SPALTEN)
    .eq("location_id", standortId)
    .lt("start_at", end)
    .or(`end_at.gte.${start},and(end_at.is.null,start_at.gte.${start})`)
    .order("start_at");
  if (error) throw error;
  return (data ?? []) as StandortTerminZeile[];
}

/** Termin-Zuteilungen der Auftraege (fuer «zugewiesen»). */
export async function kalenderZuteilungenLaden(db: SupabaseClient, jobIds: readonly string[]): Promise<Zuteilung[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await db
    .from("job_appointments")
    .select("job_id, assigned_to")
    .in("job_id", [...jobIds])
    .order("start_time")
    .order("created_at");
  if (error) throw error;
  return (data ?? []) as Zuteilung[];
}

// ─── Eintraege bauen (rein) ──────────────────────────────────────────────────

/** Anzeige-Kunde eines Auftrags: Kunde, sonst (Standort-Auftraege ohne
 *  customer_id) der Mieter aus contact_person. */
export function jobKunde(job: Pick<KalenderJob, "customer" | "contact_person">): string | null {
  return job.customer?.name?.trim() || job.contact_person?.trim() || null;
}

function jobEintrag(
  j: KalenderJob,
  art: "anfrage" | "auftrag",
  link: string | null,
  zuteilungen: readonly Zuteilung[],
  namen: ReadonlyMap<string, string>,
): KalenderEintrag {
  return {
    id: j.id,
    art,
    titel: j.title,
    kunde: jobKunde(j),
    status: j.status,
    start: j.start_date as string,
    ende: j.end_date,
    ganztaegig: false,
    notiz: null,
    zugewiesen: zugewieseneNamen(j.id, zuteilungen, namen),
    link,
    bearbeitbar: false,
  };
}

/**
 * Auftraege aus Sicht des Partners:
 *   - eigene Anfragen (istEigeneAnfrage) → «anfrage» mit Titel, Status,
 *     Kunde, Zugeteilten, Link ins Portal; abgelehnte bleiben sichtbar.
 *   - fremde, nicht stornierte: mit Kalender (partner_kalender) → «auftrag»
 *     mit Titel, Status, Kunde, Zugeteilten, ohne Link; ohne Kalender →
 *     «belegt» (Zeitraum mit kuenstlicher ID, sonst nichts — Leo 2026-10-15).
 */
export function partnerKalenderEintraege(
  jobs: readonly KalenderJob[],
  s: PartnerStandort,
  zuteilungen: readonly Zuteilung[],
  namen: ReadonlyMap<string, string>,
  opts: { kalender: boolean },
): KalenderEintrag[] {
  let n = 0;
  return jobs.flatMap((j): KalenderEintrag[] => {
    if (!j.start_date) return [];
    if (istEigeneAnfrage(j, s)) return [jobEintrag(j, "anfrage", `/partner/anfragen/${j.id}`, zuteilungen, namen)];
    if (j.status === "storniert") return [];
    if (opts.kalender) return [jobEintrag(j, "auftrag", null, zuteilungen, namen)];
    n += 1;
    return [{
      id: `belegt-${n}`,
      art: "belegt",
      titel: "Belegt",
      kunde: null,
      status: null,
      start: j.start_date,
      ende: j.end_date,
      ganztaegig: false,
      notiz: null,
      zugewiesen: [],
      link: null,
      bearbeitbar: false,
    }];
  });
}

/** Auftraege in der internen Sicht: alle nicht stornierten, «anfrage» wenn
 *  aus einer Partner-Anfrage entstanden (Regel istEigeneAnfrage mit dem
 *  Partner-Team des Standorts), sonst «auftrag»; Link /auftraege/<id>. */
export function internKalenderEintraege(
  jobs: readonly KalenderJob[],
  s: PartnerStandort,
  zuteilungen: readonly Zuteilung[],
  namen: ReadonlyMap<string, string>,
): KalenderEintrag[] {
  return jobs
    .filter((j) => j.start_date && j.is_deleted !== true && j.status !== "storniert")
    .map((j) => jobEintrag(j, istEigeneAnfrage(j, s) ? "anfrage" : "auftrag", `/auftraege/${j.id}`, zuteilungen, namen));
}

/** Eigene Termine des Standorts als Kalender-Eintraege. */
export function terminKalenderEintraege(termine: readonly StandortTerminZeile[], bearbeitbar: boolean): KalenderEintrag[] {
  return termine.map((t) => ({
    id: t.id,
    art: "termin",
    titel: t.titel,
    kunde: t.kunde,
    status: null,
    start: t.start_at,
    ende: t.end_at,
    ganztaegig: t.ganztaegig,
    notiz: t.notiz,
    zugewiesen: [],
    link: null,
    bearbeitbar,
  }));
}

/** Chronologisch nach Beginn (stabil: bei gleichem Beginn bleibt die
 *  Reihenfolge der Eingabe). */
export function kalenderSortieren(eintraege: KalenderEintrag[]): KalenderEintrag[] {
  return eintraege
    .map((e, i) => ({ e, i, t: Date.parse(e.start) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e);
}

// ─── Schreiben (Partner + intern) ────────────────────────────────────────────

export type TerminAktionErgebnis =
  | { status: 200; body: { success: true; id?: string } }
  | { status: 400 | 404; body: { success: false; error: string } };

const fehler = (status: 400 | 404, error: string): TerminAktionErgebnis => ({ status, body: { success: false, error } });

/**
 * POST-Body { aktion: "anlegen" | "aendern" | "loeschen", id?, ...TerminEingabeKalender }
 * ausfuehren — nur fuer Termine DIESES Standorts (aendern/loeschen mit
 * location_id-Filter und count:"exact", 0 Zeilen → 404). Gate (Recht +
 * partner_kalender) prueft der Aufrufer. Wirft bei DB-Fehler.
 */
export async function terminAktionAusfuehren(
  db: SupabaseClient,
  standortId: string,
  userId: string | null,
  roh: unknown,
): Promise<TerminAktionErgebnis> {
  const b = (roh && typeof roh === "object" ? roh : {}) as Record<string, unknown>;
  if (b.aktion !== "anlegen" && b.aktion !== "aendern" && b.aktion !== "loeschen") return fehler(400, "Unbekannte Aktion");

  let id: string | null = null;
  if (b.aktion !== "anlegen") {
    if (typeof b.id !== "string" || !isUuid(b.id)) return fehler(400, "Ungültige ID");
    id = b.id.toLowerCase();
  }

  if (b.aktion === "loeschen") {
    const { count, error } = await db
      .from("standort_termine")
      .delete({ count: "exact" })
      .eq("id", id!)
      .eq("location_id", standortId);
    if (error) throw error;
    if (!count) return fehler(404, "Termin nicht gefunden");
    return { status: 200, body: { success: true } };
  }

  const pruefung = kalenderTerminPruefen(b);
  if (!pruefung.ok) return fehler(400, pruefung.fehler);
  const t = pruefung.termin;
  const werte = {
    titel: t.titel,
    kunde: t.kunde,
    start_at: t.start,
    end_at: t.ende,
    ganztaegig: t.ganztaegig,
    notiz: t.notiz,
  };

  if (b.aktion === "anlegen") {
    const { data, error } = await db
      .from("standort_termine")
      .insert({ ...werte, location_id: standortId, erstellt_von: userId })
      .select("id")
      .single();
    if (error) throw error;
    return { status: 200, body: { success: true, id: (data as { id: string }).id } };
  }

  const { count, error } = await db
    .from("standort_termine")
    .update(werte, { count: "exact" })
    .eq("id", id!)
    .eq("location_id", standortId);
  if (error) throw error;
  if (!count) return fehler(404, "Termin nicht gefunden");
  return { status: 200, body: { success: true } };
}
