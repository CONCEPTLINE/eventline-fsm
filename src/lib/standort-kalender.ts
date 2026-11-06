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
import { plusTage, weekdayForDateIso } from "@/lib/swiss-time";
import { isoZuZuerich, zeitEingabeFehler, zuerichZuIso } from "@/lib/stempel-meldungen";

/** termin = eigener Einzeltermin; veranstaltung = Termin aus standort_serien
 *  (einmalig oder wiederkehrend, Migration 384); programm = aus dem
 *  Programmheft uebernommen (standort_termine.quelle = 'programmheft'). */
export type KalenderArt = "termin" | "veranstaltung" | "programm" | "anfrage" | "auftrag" | "belegt";

export type Wiederholung = "nie" | "woechentlich" | "monatlich";

/** Eingabe/Regel einer Veranstaltung (standort_serien). Zeiten "HH:MM"
 *  (Zuerich); bis <= von = endet am Folgetag. ganztaegig: von/bis null.
 *  wochentage Mo=0 … So=6 (nur woechentlich, sonst []). bisDatum = letzter
 *  moeglicher Tag (inklusiv), null = ohne Ende; bei "nie" immer null. */
export interface SerieEingabe {
  titel: string;
  kunde: string | null;
  notiz: string | null;
  /** erster Tag YYYY-MM-DD */
  datum: string;
  ganztaegig: boolean;
  von: string | null;
  bis: string | null;
  wiederholung: Wiederholung;
  wochentage: number[];
  bisDatum: string | null;
}

/** «EVENTLINE uebernimmt alle Privatvermietungen» von–bis (YYYY-MM-DD, inklusiv). */
export interface Uebernahme {
  id: string;
  von: string;
  bis: string;
  notiz: string | null;
}

export type VerfuegbarStufe = "frei" | "knapp" | "nicht";

export interface TagVerfuegbarkeit {
  /** YYYY-MM-DD (Zuerich) */
  tag: string;
  stufe: VerfuegbarStufe;
  /** intern: Namen der Freien; Partner: [] */
  frei: string[];
  /** intern: wer fehlt + Grund (Ferien, Krank, Einsatz <Location>); Partner: [] */
  weg: { name: string; grund: string }[];
  /** eine Zeile; Partner nur «EVENTLINE nicht verfügbar» / «EVENTLINE knapp» */
  text: string;
}

export interface ProgrammFund {
  /** «<URL der Veranstaltung>#<YYYY-MM-DD>» (= standort_termine.quelle_id) — mehrtägige
   *  Veranstaltungen sind je Abend ein eigener Fund mit derselben Zeit */
  quelleId: string;
  titel: string;
  /** Tag YYYY-MM-DD */
  datum: string;
  /** Beginn "HH:MM" (Zuerich) oder null = ohne Zeit (ganztaegig uebernommen) */
  von: string | null;
  bis: string | null;
  url: string;
  /** manuell = im Kalender von Hand geaendert (programm_manuell), ausgeblendet =
   *  im Kalender geloescht — beide fasst der Abgleich nicht mehr an (Migration 386) */
  status: "neu" | "vorhanden" | "geaendert" | "manuell" | "ausgeblendet";
  /** Zusatz (additiv): Kurztext der Website, z. B. «Bar ab 19h · Konzert 20h» */
  notiz: string | null;
}

/** GET …/programmheft */
export interface ProgrammheftAntwort {
  funde: ProgrammFund[];
  /** gelesene Seite, z. B. https://www.barakuba.ch/veranstaltungen/ */
  quelle: string;
  /** locations.programmheft_auto — taeglicher Abgleich an */
  auto: boolean;
  /** locations.programmheft_abgeglichen_am (ISO) oder null */
  abgeglichenAm: string | null;
}

export interface KalenderAntwort {
  eintraege: KalenderEintrag[];
  uebernahmen: Uebernahme[];
  /** nur Tage im Zeitraum mit stufe != "frei"; leer, wenn der Location niemand zugeteilt ist */
  verfuegbarkeit: TagVerfuegbarkeit[];
}

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
  /** true bei termin/programm/veranstaltung und wenn der Aufrufer schreiben darf */
  bearbeitbar: boolean;
  /** nur veranstaltung: standort_serien.id */
  serieId: string | null;
  /** nur veranstaltung: urspruenglicher Tag der Instanz (YYYY-MM-DD) —
   *  Schluessel fuer «nur diesen» aendern/loeschen */
  serienTag: string | null;
  /** veranstaltung mit wiederholung != "nie" */
  wiederkehrend: boolean;
  /** nur programm: «<URL>#<Tag>» im Programmheft */
  quelleId: string | null;
  /** nur veranstaltung: Regel der ganzen Serie ohne Ausnahmen; sonst null */
  serie: SerieEingabe | null;
  /** NUR interne Sicht, Auftrag mit Vermietungs-Ablauf (auftrag_ablauf): aktueller Schritt und
   *  ob er fuer den Partner noch verborgen ist (nicht unterschrieben). Die Partner-Antwort hat das
   *  Feld nie. */
  ablauf?: AblaufStand | null;
}

export interface AblaufStand {
  /** aktueller Schritt 1–5 */
  schritt: number;
  /** noch nicht unterschrieben → im Partner-Kalender unsichtbar */
  verborgen: boolean;
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
  /** 'programmheft' = aus dem Programmheft uebernommen (Migration 384) */
  quelle?: string | null;
  quelle_id?: string | null;
}

export type Zuteilung = { job_id: string; assigned_to: string | null };

const JOB_SPALTEN =
  "id, title, status, start_date, end_date, location_id, is_deleted, accepted_at, rejected_at, created_by, contact_person, customer:customers(name)";
const TERMIN_SPALTEN = "id, titel, kunde, start_at, end_at, ganztaegig, notiz, quelle, quelle_id";

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
    .eq("ausgeblendet", false) // geloeschte Programm-Termine (Migration 386) nie anzeigen
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

/** Felder fuer alles, was keine Veranstaltung/kein Programm ist. */
const OHNE_SERIE = { serieId: null, serienTag: null, wiederkehrend: false, quelleId: null, serie: null } as const;

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
    ...OHNE_SERIE,
  };
}

/** Stand des Vermietungs-Ablaufs (auftrag_ablauf, Migration 385) je Auftrag;
 *  Auftraege ohne Ablauf fehlen in der Map. Wirft bei DB-Fehler. */
export async function ablaufStandLaden(db: SupabaseClient, jobIds: readonly string[]): Promise<Map<string, AblaufStand>> {
  const m = new Map<string, AblaufStand>();
  if (jobIds.length === 0) return m;
  const { data, error } = await db
    .from("auftrag_ablauf")
    .select("job_id, schritt, unterschrieben_am")
    .in("job_id", [...jobIds]);
  if (error) throw error;
  for (const z of (data ?? []) as { job_id: string; schritt: number | null; unterschrieben_am: string | null }[]) {
    m.set(z.job_id, { schritt: z.schritt ?? 1, verborgen: z.unterschrieben_am == null });
  }
  return m;
}

/** Auftraege mit einem Ablauf, der noch nicht unterschrieben ist — die sieht
 *  der Partner nicht. Admin-Client (Partnersicht). Wirft bei DB-Fehler
 *  (auch wenn die Tabelle fehlt). */
export async function ablaufOffenLaden(admin: SupabaseClient, jobIds: readonly string[]): Promise<Set<string>> {
  const stand = await ablaufStandLaden(admin, jobIds);
  return new Set([...stand].filter(([, s]) => s.verborgen).map(([id]) => id));
}

/**
 * Auftraege aus Sicht des Partners:
 *   - eigene Anfragen (istEigeneAnfrage) → «anfrage» mit Titel, Status,
 *     Kunde, Zugeteilten, Link ins Portal; abgelehnte bleiben sichtbar.
 *   - fremde, nicht stornierte: mit Kalender (partner_kalender) → «auftrag»
 *     mit Titel, Status, Kunde, Zugeteilten, ohne Link; ohne Kalender →
 *     «belegt» (Zeitraum mit kuenstlicher ID, sonst nichts — Leo 2026-10-15).
 *   - fremde Auftraege in opts.ausblenden (Ablauf nicht unterschrieben) fehlen.
 */
export function partnerKalenderEintraege(
  jobs: readonly KalenderJob[],
  s: PartnerStandort,
  zuteilungen: readonly Zuteilung[],
  namen: ReadonlyMap<string, string>,
  opts: { kalender: boolean; ausblenden?: ReadonlySet<string> },
): KalenderEintrag[] {
  let n = 0;
  return jobs.flatMap((j): KalenderEintrag[] => {
    if (!j.start_date) return [];
    if (istEigeneAnfrage(j, s)) return [jobEintrag(j, "anfrage", `/partner/anfragen/${j.id}`, zuteilungen, namen)];
    if (j.status === "storniert") return [];
    // Ablauf (Etappe 2) noch nicht unterschrieben → fuer den Partner unsichtbar.
    if (opts.ausblenden?.has(j.id)) return [];
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
      ...OHNE_SERIE,
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

/** Eigene Termine des Standorts als Kalender-Eintraege («programm», wenn
 *  aus dem Programmheft uebernommen). */
export function terminKalenderEintraege(termine: readonly StandortTerminZeile[], bearbeitbar: boolean): KalenderEintrag[] {
  return termine.map((t) => ({
    ...OHNE_SERIE,
    id: t.id,
    art: t.quelle === "programmheft" ? "programm" : "termin",
    quelleId: t.quelle === "programmheft" ? (t.quelle_id ?? null) : null,
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

  let werte: { titel: string; kunde: string | null; start_at: string; end_at: string | null; ganztaegig: boolean; notiz: string | null } | null = null;
  if (b.aktion !== "loeschen") {
    const pruefung = kalenderTerminPruefen(b);
    if (!pruefung.ok) return fehler(400, pruefung.fehler);
    const t = pruefung.termin;
    werte = { titel: t.titel, kunde: t.kunde, start_at: t.start, end_at: t.ende, ganztaegig: t.ganztaegig, notiz: t.notiz };
  }

  if (b.aktion === "anlegen") {
    const { data, error } = await db
      .from("standort_termine")
      .insert({ ...werte!, location_id: standortId, erstellt_von: userId })
      .select("id")
      .single();
    if (error) throw error;
    return { status: 200, body: { success: true, id: (data as { id: string }).id } };
  }

  // Programm-Termine (Programmheft) werden nie echt geloescht, sondern
  // ausgeblendet — sonst legte der taegliche Abgleich sie wieder an. Von Hand
  // geaenderte bekommen programm_manuell (Abgleich ueberschreibt sie nicht).
  // Migration 386.
  const { data: zeileRoh, error: zErr } = await db
    .from("standort_termine")
    .select("quelle, ausgeblendet")
    .eq("id", id!)
    .eq("location_id", standortId)
    .maybeSingle();
  if (zErr) throw zErr;
  const zeile = zeileRoh as { quelle: string | null; ausgeblendet: boolean } | null;
  if (!zeile || zeile.ausgeblendet) return fehler(404, "Termin nicht gefunden");
  const istProgramm = zeile.quelle === "programmheft";

  const aenderung = b.aktion === "loeschen"
    ? istProgramm
      ? db.from("standort_termine").update({ ausgeblendet: true }, { count: "exact" })
      : db.from("standort_termine").delete({ count: "exact" })
    : db.from("standort_termine").update(istProgramm ? { ...werte!, programm_manuell: true } : werte!, { count: "exact" });
  const { count, error } = await aenderung.eq("id", id!).eq("location_id", standortId);
  if (error) throw error;
  if (!count) return fehler(404, "Termin nicht gefunden");
  return { status: 200, body: { success: true } };
}

// ─── Standort laden (Gate) ───────────────────────────────────────────────────

export interface StandortKalenderInfo {
  id: string;
  name: string;
  partner_kalender: boolean;
  programmheft_auto: boolean;
  programmheft_abgeglichen_am: string | null;
}

/** Standort mit Kalender-Schaltern; null = nicht gefunden (bzw. per RLS nicht
 *  sichtbar). Wirft bei DB-Fehler. */
export async function standortKalenderLaden(db: SupabaseClient, standortId: string): Promise<StandortKalenderInfo | null> {
  const { data, error } = await db
    .from("locations")
    .select("id, name, partner_kalender, programmheft_auto, programmheft_abgeglichen_am")
    .eq("id", standortId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const z = data as Record<string, unknown>;
  return {
    id: String(z.id),
    name: typeof z.name === "string" ? z.name : "",
    partner_kalender: z.partner_kalender === true,
    programmheft_auto: z.programmheft_auto === true,
    programmheft_abgeglichen_am: typeof z.programmheft_abgeglichen_am === "string" ? z.programmheft_abgeglichen_am : null,
  };
}

// ─── Kalendertage / Zeitraum ─────────────────────────────────────────────────

const TAG_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZEIT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Echter Kalendertag YYYY-MM-DD (kein 30.02.). */
export function istTag(v: unknown): v is string {
  if (typeof v !== "string" || !TAG_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Tage zwischen zwei Kalendertagen (b - a). */
export function tageZwischen(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** Laengster abfragbarer Zeitraum (Serien werden tageweise aufgeloest). */
export const KALENDER_ZEITRAUM_MAX_TAGE = 400;

/** start/end der Kalender-Abfrage (end exklusiv, wie kalenderJobsLaden) als
 *  Zuercher Kalendertage [vonTag, bisTag] inklusiv. null = leer oder groesser
 *  als KALENDER_ZEITRAUM_MAX_TAGE. */
export function zeitraumTage(start: string, end: string): { vonTag: string; bisTag: string } | null {
  const vonTag = TAG_RE.test(start) ? start : isoZuZuerich(start).datum;
  const bisTag = TAG_RE.test(end) ? plusTage(end, -1) : isoZuZuerich(new Date(Date.parse(end) - 1).toISOString()).datum;
  const span = tageZwischen(vonTag, bisTag);
  if (span < 0 || span > KALENDER_ZEITRAUM_MAX_TAGE) return null;
  return { vonTag, bisTag };
}

/** Wochentag Mo=0 … So=6 eines Kalendertags. */
export function wochentagMo0(tag: string): number {
  return (weekdayForDateIso(tag) + 6) % 7;
}

/** Wie zuerichZuIso, aber eine Uhrzeit, die es am Tag der Umstellung auf
 *  Sommerzeit nicht gibt (02:00–02:59), wird auf 03:00 verschoben — eine
 *  woechentliche Veranstaltung um 02:30 faellt an dem Tag nicht still aus. */
export function zuerichZuIsoSommerzeit(datum: string, zeit: string): string | null {
  const iso = zuerichZuIso(datum, zeit);
  if (iso || !/^02:[0-5]\d$/.test(zeit)) return iso;
  return zuerichZuIso(datum, "03:00");
}

/** Start/Ende als ISO aus Tag + Zeiten (Zuerich). Ganztaegig (oder ohne
 *  Beginn) = 00:00 bis 23:59 des letzten Tags; «bis» <= «von» = endet am
 *  Folgetag; ohne «bis» kein Ende (mehrtaegig: 23:59 des letzten Tags).
 *  Uhrzeiten in der Luecke der Sommerzeit-Umstellung → 03:00. null nur bei
 *  ungueltigem Datum/Format. */
export function zeitenZuIso(
  datum: string,
  ganztaegig: boolean,
  von: string | null,
  bis: string | null,
  bisDatum?: string | null,
): { start: string; ende: string | null } | null {
  const letzter = bisDatum && bisDatum > datum ? bisDatum : datum;
  if (ganztaegig || !von) {
    const s = zuerichZuIso(datum, "00:00");
    const e = zuerichZuIso(letzter, "23:59");
    return s && e ? { start: s, ende: e } : null;
  }
  const s = zuerichZuIsoSommerzeit(datum, von);
  if (!s) return null;
  if (!bis) {
    if (letzter === datum) return { start: s, ende: null };
    const e = zuerichZuIso(letzter, "23:59");
    return e ? { start: s, ende: e } : null;
  }
  const endTag = letzter === datum && bis <= von ? plusTage(datum, 1) : letzter;
  const e = zuerichZuIsoSommerzeit(endTag, bis);
  return e ? { start: s, ende: e } : null;
}

// ─── Veranstaltungen (standort_serien) ───────────────────────────────────────

/** Abweichung einer Instanz («nur diesen»); "geloescht" = Instanz entfaellt. */
export interface SerienAusnahme {
  titel: string;
  kunde: string | null;
  notiz: string | null;
  datum: string;
  ganztaegig: boolean;
  von: string | null;
  bis: string | null;
}

export interface SerieZeile {
  id: string;
  titel: string;
  kunde: string | null;
  notiz: string | null;
  datum: string;
  ganztaegig: boolean;
  von: string | null;
  bis: string | null;
  wiederholung: Wiederholung;
  wochentage: number[];
  bis_datum: string | null;
  ausnahmen: Record<string, SerienAusnahme | "geloescht">;
  updated_at: string;
}

const SERIE_SPALTEN =
  "id, titel, kunde, notiz, datum, ganztaegig, von, bis, wiederholung, wochentage, bis_datum, ausnahmen, updated_at";

/** Eine Ausnahme darf den Termin hoechstens so weit verschieben (sonst
 *  faende ihn die zeitraum-begrenzte Aufloesung nicht mehr). */
export const AUSNAHME_VERSCHIEBEN_MAX_TAGE = 31;
const AUSNAHMEN_MAX = 500;

/** DB "HH:MM:SS" → "HH:MM". */
function hm(v: unknown): string | null {
  return typeof v === "string" && v.length >= 5 ? v.slice(0, 5) : null;
}

function serieNormalisieren(roh: Record<string, unknown>): SerieZeile {
  const w = roh.wiederholung;
  const ausn =
    roh.ausnahmen && typeof roh.ausnahmen === "object" && !Array.isArray(roh.ausnahmen)
      ? (roh.ausnahmen as Record<string, unknown>)
      : {};
  const ausnahmen: SerieZeile["ausnahmen"] = {};
  for (const [tag, a] of Object.entries(ausn)) {
    if (!istTag(tag)) continue;
    if (a === "geloescht") {
      ausnahmen[tag] = "geloescht";
      continue;
    }
    if (!a || typeof a !== "object") continue;
    const x = a as Record<string, unknown>;
    if (typeof x.titel !== "string" || !istTag(x.datum)) continue;
    ausnahmen[tag] = {
      titel: x.titel,
      kunde: typeof x.kunde === "string" ? x.kunde : null,
      notiz: typeof x.notiz === "string" ? x.notiz : null,
      datum: x.datum,
      ganztaegig: x.ganztaegig === true,
      von: typeof x.von === "string" ? x.von : null,
      bis: typeof x.bis === "string" ? x.bis : null,
    };
  }
  return {
    id: String(roh.id),
    titel: String(roh.titel ?? ""),
    kunde: typeof roh.kunde === "string" ? roh.kunde : null,
    notiz: typeof roh.notiz === "string" ? roh.notiz : null,
    datum: String(roh.datum),
    ganztaegig: roh.ganztaegig === true,
    von: hm(roh.von),
    bis: hm(roh.bis),
    wiederholung: w === "woechentlich" || w === "monatlich" ? w : "nie",
    wochentage: Array.isArray(roh.wochentage) ? roh.wochentage.map(Number).filter((n) => n >= 0 && n <= 6) : [],
    bis_datum: typeof roh.bis_datum === "string" ? roh.bis_datum : null,
    ausnahmen,
    updated_at: String(roh.updated_at ?? ""),
  };
}

/** Veranstaltungen des Standorts, die Termine im Zeitraum haben koennen
 *  (inkl. Puffer fuer verschobene Ausnahmen). Wirft bei DB-Fehler. */
export async function serienLaden(db: SupabaseClient, standortId: string, vonTag: string, bisTag: string): Promise<SerieZeile[]> {
  const ab = plusTage(vonTag, -AUSNAHME_VERSCHIEBEN_MAX_TAGE);
  const { data, error } = await db
    .from("standort_serien")
    .select(SERIE_SPALTEN)
    .eq("location_id", standortId)
    .lte("datum", plusTage(bisTag, AUSNAHME_VERSCHIEBEN_MAX_TAGE))
    .or(`bis_datum.gte.${ab},and(bis_datum.is.null,wiederholung.neq.nie),and(wiederholung.eq.nie,datum.gte.${ab})`)
    .order("datum");
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(serieNormalisieren);
}

/** Faellt ein (urspruenglicher) Serien-Tag auf `tag`? Monatlich: gleicher
 *  Tag im Monat (fehlt er, z. B. 31., entfaellt der Termin). */
export function serieTrifft(s: Pick<SerieZeile, "datum" | "wiederholung" | "wochentage" | "bis_datum">, tag: string): boolean {
  if (tag < s.datum) return false;
  if (s.wiederholung === "nie") return tag === s.datum;
  if (s.bis_datum && tag > s.bis_datum) return false;
  if (s.wiederholung === "woechentlich") return s.wochentage.includes(wochentagMo0(tag));
  return tag.slice(8, 10) === s.datum.slice(8, 10);
}

/** Regel der Serie in Vertragsform (ohne Ausnahmen). */
export function serieRegel(s: SerieZeile): SerieEingabe {
  return {
    titel: s.titel,
    kunde: s.kunde,
    notiz: s.notiz,
    datum: s.datum,
    ganztaegig: s.ganztaegig,
    von: s.ganztaegig ? null : s.von,
    bis: s.ganztaegig ? null : s.bis,
    wiederholung: s.wiederholung,
    wochentage: s.wiederholung === "woechentlich" ? [...s.wochentage].sort((a, b) => a - b) : [],
    bisDatum: s.wiederholung === "nie" ? null : s.bis_datum,
  };
}

/** Alle Termine einer Serie im Zeitraum [vonTag, bisTag] (inklusiv). Iteriert
 *  nur ueber den Zeitraum ± Puffer (und nie ueber das Serienende) — nie endlos. */
export function serieAufloesen(s: SerieZeile, vonTag: string, bisTag: string, bearbeitbar: boolean): KalenderEintrag[] {
  const puffer = AUSNAHME_VERSCHIEBEN_MAX_TAGE;
  const frueh = plusTage(vonTag, -puffer);
  let ende = plusTage(bisTag, puffer);
  if (s.wiederholung === "nie") ende = s.datum < ende ? s.datum : ende;
  else if (s.bis_datum && s.bis_datum < ende) ende = s.bis_datum;
  const regel = serieRegel(s);
  const out: KalenderEintrag[] = [];
  for (let t = s.datum > frueh ? s.datum : frueh; t <= ende; t = plusTage(t, 1)) {
    if (!serieTrifft(s, t)) continue;
    const a = s.ausnahmen[t];
    if (a === "geloescht") continue;
    const d: SerienAusnahme = a ?? {
      titel: s.titel,
      kunde: s.kunde,
      notiz: s.notiz,
      datum: t,
      ganztaegig: s.ganztaegig,
      von: s.von,
      bis: s.bis,
    };
    if (d.datum < vonTag || d.datum > bisTag) continue;
    const z = zeitenZuIso(d.datum, d.ganztaegig, d.von, d.bis);
    if (!z) continue;
    out.push({
      id: `${s.id}@${t}`,
      art: "veranstaltung",
      titel: d.titel,
      kunde: d.kunde,
      status: null,
      start: z.start,
      ende: z.ende,
      ganztaegig: d.ganztaegig,
      notiz: d.notiz,
      zugewiesen: [],
      link: null,
      bearbeitbar,
      serieId: s.id,
      serienTag: t,
      wiederkehrend: s.wiederholung !== "nie",
      quelleId: null,
      serie: regel,
    });
  }
  return out;
}

/** Eingabe einer Veranstaltung pruefen (Grenzen wie Migration 384). */
export function serieEingabePruefen(roh: unknown): { ok: true; eingabe: SerieEingabe } | { ok: false; fehler: string } {
  const b = (roh && typeof roh === "object" ? roh : {}) as Record<string, unknown>;

  const titel = typeof b.titel === "string" ? b.titel.trim() : "";
  if (!titel) return { ok: false, fehler: "Titel fehlt" };
  if (titel.length > KALENDER_TITEL_MAX) return { ok: false, fehler: `Titel ist zu lang (höchstens ${KALENDER_TITEL_MAX} Zeichen)` };
  if (b.kunde != null && typeof b.kunde !== "string") return { ok: false, fehler: "Ungültiger Kunde" };
  const kunde = typeof b.kunde === "string" ? b.kunde.trim() : "";
  if (kunde.length > KALENDER_KUNDE_MAX) return { ok: false, fehler: `Kunde ist zu lang (höchstens ${KALENDER_KUNDE_MAX} Zeichen)` };
  if (b.notiz != null && typeof b.notiz !== "string") return { ok: false, fehler: "Ungültige Notiz" };
  const notiz = typeof b.notiz === "string" ? b.notiz.trim() : "";
  if (notiz.length > KALENDER_NOTIZ_MAX) return { ok: false, fehler: `Notiz ist zu lang (höchstens ${KALENDER_NOTIZ_MAX} Zeichen)` };

  if (!istTag(b.datum)) return { ok: false, fehler: "Datum fehlt oder ist ungültig" };
  const datum = b.datum;
  if (b.ganztaegig != null && typeof b.ganztaegig !== "boolean") return { ok: false, fehler: "Ungültige Angabe «ganztägig»" };
  const ganztaegig = b.ganztaegig === true;

  let von: string | null = null;
  let bis: string | null = null;
  if (!ganztaegig) {
    if (typeof b.von !== "string" || !ZEIT_RE.test(b.von)) return { ok: false, fehler: "Beginn (Uhrzeit) fehlt oder ist ungültig" };
    von = b.von;
    if (b.bis != null && b.bis !== "") {
      if (typeof b.bis !== "string" || !ZEIT_RE.test(b.bis)) return { ok: false, fehler: "Ungültiges Ende (Uhrzeit)" };
      bis = b.bis;
    }
    const dst = zeitEingabeFehler(datum, von);
    if (dst) return { ok: false, fehler: dst };
    // «bis» <= «von» endet am Folgetag — dort pruefen.
    const dstBis = bis ? zeitEingabeFehler(bis <= von ? plusTage(datum, 1) : datum, bis) : null;
    if (dstBis) return { ok: false, fehler: dstBis };
  }

  const w = b.wiederholung ?? "nie";
  if (w !== "nie" && w !== "woechentlich" && w !== "monatlich") return { ok: false, fehler: "Ungültige Wiederholung" };
  let wochentage: number[] = [];
  if (w === "woechentlich") {
    if (!Array.isArray(b.wochentage) || b.wochentage.length === 0) return { ok: false, fehler: "Mindestens einen Wochentag wählen" };
    if (!b.wochentage.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6)) {
      return { ok: false, fehler: "Ungültige Wochentage" };
    }
    wochentage = [...new Set(b.wochentage as number[])].sort((x, y) => x - y);
  }
  let bisDatum: string | null = null;
  if (w !== "nie" && b.bisDatum != null && b.bisDatum !== "") {
    if (!istTag(b.bisDatum)) return { ok: false, fehler: "Ungültiges Enddatum der Wiederholung" };
    if (b.bisDatum < datum) return { ok: false, fehler: "Wiederholung endet vor dem ersten Termin" };
    bisDatum = b.bisDatum;
  }

  return {
    ok: true,
    eingabe: { titel, kunde: kunde || null, notiz: notiz || null, datum, ganztaegig, von, bis, wiederholung: w, wochentage, bisDatum },
  };
}

// ─── Aktionen: Veranstaltungen + Uebernahmen ─────────────────────────────────

export type KalenderAktionErgebnis =
  | { status: 200; body: { success: true; id?: string } }
  | { status: 400 | 404 | 409; body: { success: false; error: string } };

const aktionFehler = (status: 400 | 404 | 409, error: string): KalenderAktionErgebnis => ({
  status,
  body: { success: false, error },
});
const AKTION_OK: KalenderAktionErgebnis = { status: 200, body: { success: true } };

function serieWerte(e: SerieEingabe) {
  return {
    titel: e.titel,
    kunde: e.kunde,
    notiz: e.notiz,
    ganztaegig: e.ganztaegig,
    von: e.ganztaegig ? null : e.von,
    bis: e.ganztaegig ? null : e.bis,
    wiederholung: e.wiederholung,
    wochentage: e.wiederholung === "woechentlich" ? e.wochentage : [],
    bis_datum: e.wiederholung === "nie" ? null : e.bisDatum,
  };
}

/** POST …/kalender-serien (SerieEingabe) — neue Veranstaltung. Gate (Recht +
 *  partner_kalender) prueft der Aufrufer. Wirft bei DB-Fehler. */
export async function serieAnlegen(
  db: SupabaseClient,
  standortId: string,
  userId: string | null,
  roh: unknown,
): Promise<KalenderAktionErgebnis> {
  const p = serieEingabePruefen(roh);
  if (!p.ok) return aktionFehler(400, p.fehler);
  const { data, error } = await db
    .from("standort_serien")
    .insert({ ...serieWerte(p.eingabe), datum: p.eingabe.datum, ausnahmen: {}, location_id: standortId, erstellt_von: userId })
    .select("id")
    .single();
  if (error) throw error;
  return { status: 200, body: { success: true, id: (data as { id: string }).id } };
}

async function serieHolen(db: SupabaseClient, standortId: string, id: string): Promise<SerieZeile | null> {
  const { data, error } = await db
    .from("standort_serien")
    .select(SERIE_SPALTEN)
    .eq("id", id)
    .eq("location_id", standortId)
    .maybeSingle();
  if (error) throw error;
  return data ? serieNormalisieren(data as Record<string, unknown>) : null;
}

/** Ausnahmen schreiben — nur wenn die Serie seit dem Lesen unveraendert ist
 *  (updated_at), sonst 409 statt still eine andere Aenderung zu ueberschreiben. */
async function ausnahmenSchreiben(
  db: SupabaseClient,
  s: SerieZeile,
  standortId: string,
  ausnahmen: SerieZeile["ausnahmen"],
): Promise<KalenderAktionErgebnis> {
  if (Object.keys(ausnahmen).length > AUSNAHMEN_MAX) return aktionFehler(400, "Zu viele Einzeländerungen in dieser Serie");
  const { count, error } = await db
    .from("standort_serien")
    .update({ ausnahmen }, { count: "exact" })
    .eq("id", s.id)
    .eq("location_id", standortId)
    .eq("updated_at", s.updated_at);
  if (error) throw error;
  if (!count) return aktionFehler(409, "Die Veranstaltung wurde inzwischen geändert — bitte neu laden");
  return AKTION_OK;
}

function serienTagPruefen(s: SerieZeile, roh: unknown): { ok: true; tag: string } | { ok: false; e: KalenderAktionErgebnis } {
  if (!istTag(roh)) return { ok: false, e: aktionFehler(400, "Ungültiger Serien-Tag") };
  if (!serieTrifft(s, roh)) return { ok: false, e: aktionFehler(404, "Termin nicht gefunden") };
  return { ok: true, tag: roh };
}

/** PATCH …/kalender-serien/[id] — body { umfang: "serie" | "nur_diesen", serienTag?, eingabe }.
 *  «serie»: Inhalt + Regel + erstes Datum (eingabe.datum = neuer Beginn der
 *  Serie); Einzelaenderungen, deren urspruenglicher Tag nach der neuen Regel
 *  nicht mehr zur Serie gehoert, entfallen. «nur_diesen»: Ausnahme fuer
 *  serienTag (Wiederholungsfelder der Eingabe werden ignoriert). */
export async function serieAendern(
  db: SupabaseClient,
  standortId: string,
  idRoh: string,
  roh: unknown,
): Promise<KalenderAktionErgebnis> {
  if (!isUuid(idRoh)) return aktionFehler(400, "Ungültige ID");
  const b = (roh && typeof roh === "object" ? roh : {}) as Record<string, unknown>;
  if (b.umfang !== "serie" && b.umfang !== "nur_diesen") return aktionFehler(400, "Ungültiger Umfang");
  const p = serieEingabePruefen(b.eingabe);
  if (!p.ok) return aktionFehler(400, p.fehler);
  const e = p.eingabe;
  const s = await serieHolen(db, standortId, idRoh.toLowerCase());
  if (!s) return aktionFehler(404, "Veranstaltung nicht gefunden");

  if (b.umfang === "nur_diesen") {
    const t = serienTagPruefen(s, b.serienTag);
    if (!t.ok) return t.e;
    if (Math.abs(tageZwischen(t.tag, e.datum)) > AUSNAHME_VERSCHIEBEN_MAX_TAGE) {
      return aktionFehler(400, `Ein einzelner Termin lässt sich höchstens ${AUSNAHME_VERSCHIEBEN_MAX_TAGE} Tage verschieben`);
    }
    const ausnahme: SerienAusnahme = {
      titel: e.titel,
      kunde: e.kunde,
      notiz: e.notiz,
      datum: e.datum,
      ganztaegig: e.ganztaegig,
      von: e.ganztaegig ? null : e.von,
      bis: e.ganztaegig ? null : e.bis,
    };
    return ausnahmenSchreiben(db, s, standortId, { ...s.ausnahmen, [t.tag]: ausnahme });
  }

  const werte = { ...serieWerte(e), datum: e.datum };
  // Einzelaenderungen nur behalten, wenn ihr urspruenglicher Tag weiter zur
  // Serie gehoert (sonst haengen sie unsichtbar in ausnahmen).
  const neueRegel = { datum: werte.datum, wiederholung: werte.wiederholung, wochentage: werte.wochentage, bis_datum: werte.bis_datum };
  const ausnahmen = Object.fromEntries(Object.entries(s.ausnahmen).filter(([tag]) => serieTrifft(neueRegel, tag)));
  // Nur wenn die Serie seit dem Lesen unveraendert ist (updated_at) — sonst
  // 409 statt still eine andere Aenderung zu ueberschreiben.
  const { count, error } = await db
    .from("standort_serien")
    .update({ ...werte, ausnahmen }, { count: "exact" })
    .eq("id", s.id)
    .eq("location_id", standortId)
    .eq("updated_at", s.updated_at);
  if (error) throw error;
  if (!count) return aktionFehler(409, "Die Veranstaltung wurde inzwischen geändert — bitte neu laden");
  return AKTION_OK;
}

/** DELETE …/kalender-serien/[id]?umfang=serie|nur_diesen&serienTag= */
export async function serieLoeschen(
  db: SupabaseClient,
  standortId: string,
  idRoh: string,
  umfang: string | null,
  serienTag: string | null,
): Promise<KalenderAktionErgebnis> {
  if (!isUuid(idRoh)) return aktionFehler(400, "Ungültige ID");
  const id = idRoh.toLowerCase();
  if (umfang !== "serie" && umfang !== "nur_diesen") return aktionFehler(400, "Ungültiger Umfang");
  if (umfang === "serie") {
    const { count, error } = await db
      .from("standort_serien")
      .delete({ count: "exact" })
      .eq("id", id)
      .eq("location_id", standortId);
    if (error) throw error;
    if (!count) return aktionFehler(404, "Veranstaltung nicht gefunden");
    return AKTION_OK;
  }
  const s = await serieHolen(db, standortId, id);
  if (!s) return aktionFehler(404, "Veranstaltung nicht gefunden");
  const t = serienTagPruefen(s, serienTag);
  if (!t.ok) return t.e;
  return ausnahmenSchreiben(db, s, standortId, { ...s.ausnahmen, [t.tag]: "geloescht" });
}

/** Uebernahmen des Standorts, die den Zeitraum beruehren. Wirft bei DB-Fehler. */
export async function uebernahmenLaden(db: SupabaseClient, standortId: string, vonTag: string, bisTag: string): Promise<Uebernahme[]> {
  const { data, error } = await db
    .from("standort_uebernahmen")
    .select("id, von, bis, notiz")
    .eq("location_id", standortId)
    .lte("von", bisTag)
    .gte("bis", vonTag)
    .order("von");
  if (error) throw error;
  return (data ?? []) as Uebernahme[];
}

function uebernahmePruefen(roh: unknown): { ok: true; u: Omit<Uebernahme, "id"> } | { ok: false; fehler: string } {
  const b = (roh && typeof roh === "object" ? roh : {}) as Record<string, unknown>;
  if (!istTag(b.von)) return { ok: false, fehler: "«Von» fehlt oder ist ungültig" };
  if (!istTag(b.bis)) return { ok: false, fehler: "«Bis» fehlt oder ist ungültig" };
  if (b.bis < b.von) return { ok: false, fehler: "«Bis» liegt vor «Von»" };
  if (b.notiz != null && typeof b.notiz !== "string") return { ok: false, fehler: "Ungültige Notiz" };
  const notiz = typeof b.notiz === "string" ? b.notiz.trim() : "";
  if (notiz.length > KALENDER_NOTIZ_MAX) return { ok: false, fehler: `Notiz ist zu lang (höchstens ${KALENDER_NOTIZ_MAX} Zeichen)` };
  return { ok: true, u: { von: b.von, bis: b.bis, notiz: notiz || null } };
}

/** POST …/uebernahmen ({von,bis,notiz}). */
export async function uebernahmeAnlegen(
  db: SupabaseClient,
  standortId: string,
  userId: string | null,
  roh: unknown,
): Promise<KalenderAktionErgebnis> {
  const p = uebernahmePruefen(roh);
  if (!p.ok) return aktionFehler(400, p.fehler);
  const { data, error } = await db
    .from("standort_uebernahmen")
    .insert({ ...p.u, location_id: standortId, erstellt_von: userId })
    .select("id")
    .single();
  if (error) throw error;
  return { status: 200, body: { success: true, id: (data as { id: string }).id } };
}

/** PATCH …/uebernahmen/[id] ({von,bis,notiz}). */
export async function uebernahmeAendern(
  db: SupabaseClient,
  standortId: string,
  idRoh: string,
  roh: unknown,
): Promise<KalenderAktionErgebnis> {
  if (!isUuid(idRoh)) return aktionFehler(400, "Ungültige ID");
  const p = uebernahmePruefen(roh);
  if (!p.ok) return aktionFehler(400, p.fehler);
  const { count, error } = await db
    .from("standort_uebernahmen")
    .update(p.u, { count: "exact" })
    .eq("id", idRoh.toLowerCase())
    .eq("location_id", standortId);
  if (error) throw error;
  if (!count) return aktionFehler(404, "Eintrag nicht gefunden");
  return AKTION_OK;
}

/** DELETE …/uebernahmen/[id]. */
export async function uebernahmeLoeschen(db: SupabaseClient, standortId: string, idRoh: string): Promise<KalenderAktionErgebnis> {
  if (!isUuid(idRoh)) return aktionFehler(400, "Ungültige ID");
  const { count, error } = await db
    .from("standort_uebernahmen")
    .delete({ count: "exact" })
    .eq("id", idRoh.toLowerCase())
    .eq("location_id", standortId);
  if (error) throw error;
  if (!count) return aktionFehler(404, "Eintrag nicht gefunden");
  return AKTION_OK;
}

/** PATCH/DELETE-Form fuer Einzeltermine (…/kalender-termine) auf das
 *  bestehende POST-Format { aktion, id, … } abbilden. */
export function terminBodyMitAktion(aktion: "aendern" | "loeschen", body: unknown, id: string | null): Record<string, unknown> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return { ...b, aktion, id: id ?? b.id };
}
