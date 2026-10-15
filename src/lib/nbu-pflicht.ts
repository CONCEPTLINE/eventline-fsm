/**
 * NBU-Pflicht — wann wird der Arbeitnehmer-Abzug fuer die
 * Nichtberufsunfall-Versicherung (NBU) gemacht?
 *
 * Rechtsgrundlage: Art. 13 Abs. 1 UVV — Teilzeitbeschaeftigte, deren
 * woechentliche Arbeitszeit bei EINEM Arbeitgeber mindestens 8 Stunden
 * betraegt, sind auch gegen Nichtberufsunfaelle versichert. Wer darunter
 * liegt, ist nicht NBU-versichert: kein NBU-Abzug vom Lohn, Unfaelle auf dem
 * Arbeitsweg gelten als Berufsunfall (Art. 13 Abs. 2 UVV). Die
 * Arbeitgeberpraemie BU bleibt davon unberuehrt.
 *
 * Unregelmaessige Arbeitszeit (Stundenlohn, Einsaetze nach Bedarf):
 * massgebend ist die DURCHSCHNITTLICHE woechentliche Arbeitszeit (Suva-Praxis;
 * Durchschnittsmethode nach EVG-Urteil U 84/03 bzw. SVV-Empfehlung 2019:
 * Betrachtung der «letzten 3 oder 12 Monate»). Umsetzung hier:
 *
 *   1. Basis sind die Stempelzeiten (time_entries, nur abgeschlossene
 *      Eintraege) — dieselbe Lohnbasis wie die Lohnabrechnung (seit Commit
 *      bfabf504) und dieselbe Minuten-Zaehlung (forEachMinuteSegment,
 *      Europe/Zurich, sommerzeit-sicher: gezaehlt wird die echt gearbeitete
 *      Zeit).
 *   2. Wochen laufen Montag–Sonntag (Europe/Zurich). Eine Woche gehoert zu
 *      dem Monat, in dem ihr Donnerstag liegt (ISO-8601-Regel der
 *      Kalenderwochen) — so zaehlt jede Woche ganz und genau einmal, auch
 *      wenn sie ueber eine Monatsgrenze laeuft.
 *   3. Betrachtungszeitraum fuer die Abrechnung des Monats M = die
 *      NBU_BETRACHTUNG_MONATE Monate bis Ende M (bei 3: M-2, M-1, M).
 *   4. Gezaehlt werden nur Wochen, in denen die Person ueberhaupt gearbeitet
 *      hat (Stempelzeit > 0).
 *   5. NBU-versichert, wenn
 *        a) der Durchschnitt der Stunden je gearbeiteter Woche
 *           >= NBU_MIN_STUNDEN_PRO_WOCHE ist          → regel "durchschnitt"
 *        ODER
 *        b) mehr als die Haelfte der gearbeiteten Wochen mindestens
 *           NBU_MIN_STUNDEN_PRO_WOCHE hat (SVV-Empfehlung) → regel "mehrheit"
 *      sonst nicht versichert (regel "keine"). Keine gearbeitete Woche →
 *      nicht versichert, Abzug 0.
 *
 * ANNAHME (mit der Suva zu bestaetigen): Durchschnittsmethode, 3 Monate,
 * Mehrheitsregel und die Wochen-Zuordnung ueber den Donnerstag. Die
 * Konstanten sind bewusst benannt, damit sie nach der Bestaetigung an EINER
 * Stelle angepasst werden koennen.
 *
 * Verwendet von: Lohnabrechnung (PDF), Monatsstunden-Tabelle, Timesheet-
 * Export, Lohn-Details, Dashboard «Mein Monat» — damit alle Stellen
 * dasselbe zeigen.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { forEachMinuteSegment, plusTage } from "@/lib/swiss-time";
import { sumEmployeePct, type LohnPctSet } from "@/lib/employer-costs";

/** Art. 13 Abs. 1 UVV: Mindest-Wochenarbeitszeit bei EINEM Arbeitgeber
 *  (hier: bei EVENTLINE), ab der eine Person NBU-versichert ist. */
export const NBU_MIN_STUNDEN_PRO_WOCHE = 8;

/** Betrachtungszeitraum in Monaten bis Ende des Abrechnungsmonats
 *  (SVV-Empfehlung 2019: «letzte 3 oder 12 Monate»). ANNAHME: 3 —
 *  mit der Suva zu bestaetigen. */
export const NBU_BETRACHTUNG_MONATE = 3;

/** Kurzer Hinweis fuer Stellen, die den NBU-Satz nur als Stammdatum zeigen. */
export const NBU_HINWEIS_KURZ = `wird nur abgezogen, wenn Ø ≥ ${NBU_MIN_STUNDEN_PRO_WOCHE} h/Woche`;

/** Ausfuehrlicher Hinweis (Tooltip) zu NBU_HINWEIS_KURZ. */
export const NBU_HINWEIS_LANG =
  `Art. 13 UVV: NBU-versichert ist, wer bei EVENTLINE im Schnitt mindestens ${NBU_MIN_STUNDEN_PRO_WOCHE} Stunden pro Woche arbeitet. ` +
  `Massgebend sind die Stempelzeiten der letzten ${NBU_BETRACHTUNG_MONATE} Monate bis Ende des Abrechnungsmonats: ` +
  `Ø pro gearbeiteter Woche mindestens ${NBU_MIN_STUNDEN_PRO_WOCHE} h oder mehr als die Hälfte der gearbeiteten Wochen mit mindestens ${NBU_MIN_STUNDEN_PRO_WOCHE} h. ` +
  `Sonst kein NBU-Abzug (Arbeitsweg-Unfälle gelten dann als Berufsunfall).`;

/** Welche Regel den Ausschlag gab ("keine" = nicht versichert). */
export type NbuRegel = "durchschnitt" | "mehrheit" | "keine";

export interface NbuStatus {
  /** true = NBU-versichert → der Arbeitnehmer-Abzug NBU wird gemacht. */
  versichert: boolean;
  /** Ø Stunden je gearbeiteter Woche im Betrachtungszeitraum (ungerundet). */
  durchschnittStundenProWoche: number;
  /** Anzahl Wochen mit Stempelzeit im Betrachtungszeitraum. */
  gearbeiteteWochen: number;
  /** Davon Wochen mit mindestens NBU_MIN_STUNDEN_PRO_WOCHE Stunden. */
  wochenAb8h: number;
  regel: NbuRegel;
}

/** Stempel-Eintrag fuer die Pruefung. Ende null/undefined = noch offen
 *  (eingestempelt) → zaehlt nicht. */
export interface NbuStempelEintrag {
  start: string | number | Date;
  ende: string | number | Date | null | undefined;
}

export interface Abrechnungsmonat {
  jahr: number;
  /** 1–12 */
  monat: number;
}

/** Status ohne gearbeitete Woche — nicht versichert. */
export const NBU_STATUS_KEINE_ARBEIT: NbuStatus = Object.freeze({
  versichert: false,
  durchschnittStundenProWoche: 0,
  gearbeiteteWochen: 0,
  wochenAb8h: 0,
  regel: "keine",
});

// Toleranz gegen Gleitkomma-Rauschen bei Stunden-Eingaben (in Minuten,
// = 0.06 ms). Stempel-Minuten sind ganzzahlig und davon nicht betroffen.
const EPS_MINUTEN = 1e-6;

// Wochen-Zuordnung ueber den Donnerstag: der Montag einer Woche liegt
// hoechstens 3 Tage vor, der Sonntag hoechstens 3 Tage nach dem Monat, dem
// die Woche zugeordnet ist.
const WOCHEN_RAND_TAGE = 3;
// Lade-Puffer fuer Schichten ueber Mitternacht/Wochenrand + UTC-Versatz.
const LADE_PUFFER_TAGE = 2;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM" — Schluessel fuer Monats-Maps. */
export function monatsSchluessel(jahr: number, monat: number): string {
  return `${jahr}-${pad2(monat)}`;
}

function pruefeMonat(jahr: number, monat: number): void {
  if (!Number.isInteger(jahr) || !Number.isInteger(monat) || monat < 1 || monat > 12) {
    throw new Error(`NBU-Prüfung: ungültiger Abrechnungsmonat ${jahr}-${monat}`);
  }
}

function monatVerschieben(jahr: number, monat: number, delta: number): Abrechnungsmonat {
  const idx = jahr * 12 + (monat - 1) + delta;
  return { jahr: Math.floor(idx / 12), monat: (((idx % 12) + 12) % 12) + 1 };
}

/** Montag (YYYY-MM-DD) der Woche, in der der lokale Kalendertag liegt.
 *  Reine Kalender-Arithmetik (zeitzonenfrei), Woche = Montag–Sonntag. */
export function wochenMontag(isoDatum: string): string {
  const [y, m, d] = isoDatum.split("-").map(Number);
  const wochentag = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sonntag
  return plusTage(isoDatum, -((wochentag + 6) % 7));
}

/** Betrachtungszeitraum (lokale Kalendertage, beide inklusiv) fuer die
 *  Abrechnung des Monats M: erster Tag von M-(NBU_BETRACHTUNG_MONATE-1)
 *  bis letzter Tag von M. */
export function nbuBetrachtungszeitraum(jahr: number, monat: number): { von: string; bis: string } {
  pruefeMonat(jahr, monat);
  const start = monatVerschieben(jahr, monat, -(NBU_BETRACHTUNG_MONATE - 1));
  const folge = monatVerschieben(jahr, monat, 1);
  return {
    von: `${start.jahr}-${pad2(start.monat)}-01`,
    bis: plusTage(`${folge.jahr}-${pad2(folge.monat)}-01`, -1),
  };
}

/** Gehoert die Woche (gegeben durch ihren Montag) in den Zeitraum?
 *  Zuordnung ueber den Donnerstag (ISO 8601). */
function wocheImZeitraum(montag: string, zeitraum: { von: string; bis: string }): boolean {
  const donnerstag = plusTage(montag, 3);
  return donnerstag >= zeitraum.von && donnerstag <= zeitraum.bis;
}

function zeitMs(v: string | number | Date): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  return new Date(v).getTime();
}

/** Stempel-Minuten je Kalenderwoche (Schluessel = Montag YYYY-MM-DD,
 *  Europe/Zurich). Offene Eintraege (ohne Ende) und ungueltige (Ende vor
 *  Start) zaehlen nicht. Minuten-Zaehlung identisch zur Lohnabrechnung. */
export function stempelMinutenJeWoche(eintraege: readonly NbuStempelEintrag[]): Map<string, number> {
  const jeWoche = new Map<string, number>();
  const montagJeTag = new Map<string, string>();
  for (const e of eintraege) {
    if (e.ende == null) continue;
    const start = zeitMs(e.start);
    const ende = zeitMs(e.ende);
    if (!Number.isFinite(start) || !Number.isFinite(ende) || ende <= start) continue;
    forEachMinuteSegment(start, ende, (datum, _stunde, minuten) => {
      let montag = montagJeTag.get(datum);
      if (!montag) {
        montag = wochenMontag(datum);
        montagJeTag.set(datum, montag);
      }
      jeWoche.set(montag, (jeWoche.get(montag) ?? 0) + minuten);
    });
  }
  return jeWoche;
}

/** Die Regel selbst, auf die Minuten je Woche des Betrachtungszeitraums. */
function regelAnwenden(minutenJeWoche: readonly number[]): NbuStatus {
  const gearbeitet = minutenJeWoche.filter((m) => Number.isFinite(m) && m > 0);
  const anzahl = gearbeitet.length;
  if (anzahl === 0) return { ...NBU_STATUS_KEINE_ARBEIT };
  const schwelle = NBU_MIN_STUNDEN_PRO_WOCHE * 60;
  const total = gearbeitet.reduce((s, m) => s + m, 0);
  const wochenAb8h = gearbeitet.filter((m) => m + EPS_MINUTEN >= schwelle).length;
  const durchschnittErreicht = total + EPS_MINUTEN >= schwelle * anzahl;
  const mehrheitErreicht = 2 * wochenAb8h > anzahl;
  const regel: NbuRegel = durchschnittErreicht ? "durchschnitt" : mehrheitErreicht ? "mehrheit" : "keine";
  return {
    versichert: regel !== "keine",
    durchschnittStundenProWoche: total / anzahl / 60,
    gearbeiteteWochen: anzahl,
    wochenAb8h,
    regel,
  };
}

/** Regel auf Stunden je Woche des Betrachtungszeitraums (Wochen mit 0 h
 *  werden ignoriert). */
export function nbuStatusAusWochenstunden(stundenJeWoche: readonly number[]): NbuStatus {
  return regelAnwenden(stundenJeWoche.map((h) => h * 60));
}

/** Status fuer den Abrechnungsmonat aus den Minuten je Woche
 *  (stempelMinutenJeWoche). Effizient, wenn mehrere Monate derselben
 *  Person ausgewertet werden. */
export function nbuStatusFuerMonat(
  minutenJeWoche: ReadonlyMap<string, number>,
  jahr: number,
  monat: number,
): NbuStatus {
  const zeitraum = nbuBetrachtungszeitraum(jahr, monat);
  const werte: number[] = [];
  for (const [montag, minuten] of minutenJeWoche) {
    if (wocheImZeitraum(montag, zeitraum)) werte.push(minuten);
  }
  return regelAnwenden(werte);
}

/** Status fuer den Abrechnungsmonat direkt aus Stempel-Eintraegen. */
export function nbuStatusAusStempel(
  eintraege: readonly NbuStempelEintrag[],
  jahr: number,
  monat: number,
): NbuStatus {
  return nbuStatusFuerMonat(stempelMinutenJeWoche(eintraege), jahr, monat);
}

/** Abrechnungsmonate, die ein Zeitraum (YYYY-MM-DD, inklusiv) beruehrt. */
export function abrechnungsmonateImZeitraum(von: string, bis: string): Abrechnungsmonat[] {
  const [vj, vm] = von.split("-").map(Number);
  const [bj, bm] = bis.split("-").map(Number);
  const monate: Abrechnungsmonat[] = [];
  for (let m = { jahr: vj, monat: vm }; m.jahr * 12 + m.monat <= bj * 12 + bm; m = monatVerschieben(m.jahr, m.monat, 1)) {
    monate.push(m);
  }
  return monate;
}

/** UTC-Grenzen fuer die DB-Abfrage der Stempelzeiten: alle Wochen der
 *  Betrachtungszeitraeume der Monate plus Puffer fuer Schichten ueber
 *  Mitternacht. clock_in >= vonIso und < bisIso. */
export function nbuLadeZeitraum(monate: readonly Abrechnungsmonat[]): { vonIso: string; bisIso: string } {
  if (monate.length === 0) throw new Error("NBU-Prüfung: kein Abrechnungsmonat angegeben");
  let von = "";
  let bis = "";
  for (const m of monate) {
    const z = nbuBetrachtungszeitraum(m.jahr, m.monat);
    if (!von || z.von < von) von = z.von;
    if (!bis || z.bis > bis) bis = z.bis;
  }
  return {
    vonIso: `${plusTage(von, -(WOCHEN_RAND_TAGE + LADE_PUFFER_TAGE))}T00:00:00Z`,
    bisIso: `${plusTage(bis, WOCHEN_RAND_TAGE + LADE_PUFFER_TAGE)}T00:00:00Z`,
  };
}

/** Laedt die abgeschlossenen Stempelzeiten der Personen (time_entries:
 *  user_id, clock_in, clock_out) und bestimmt den NBU-Status je Person und
 *  Abrechnungsmonat. Ergebnis: profileId → "YYYY-MM" → Status (Personen ohne
 *  Stempelzeit: nicht versichert). Seitenweise geladen — PostgREST kappt
 *  sonst still bei max_rows. Fehler werden geworfen, nie als «nicht
 *  versichert» verschluckt. Erwartet einen Client, der alle Zeilen der
 *  Personen lesen darf (Admin-Client in den Lohn-Routen). */
export async function ladeNbuStatus(
  client: SupabaseClient,
  profileIds: readonly string[],
  monate: readonly Abrechnungsmonat[],
): Promise<Map<string, Map<string, NbuStatus>>> {
  const ergebnis = new Map<string, Map<string, NbuStatus>>();
  const ids = Array.from(new Set(profileIds));
  if (ids.length === 0 || monate.length === 0) return ergebnis;
  const { vonIso, bisIso } = nbuLadeZeitraum(monate);

  type Zeile = { user_id: string; clock_in: string; clock_out: string | null };
  const eintraegeJePerson = new Map<string, NbuStempelEintrag[]>();
  const SEITE = 1000;
  for (let ab = 0; ; ab += SEITE) {
    const { data, error } = await client
      .from("time_entries")
      .select("id, user_id, clock_in, clock_out")
      .in("user_id", ids)
      .not("clock_out", "is", null)
      .gte("clock_in", vonIso)
      .lt("clock_in", bisIso)
      .order("clock_in", { ascending: true })
      .order("id", { ascending: true })
      .range(ab, ab + SEITE - 1);
    if (error) throw new Error(`NBU-Prüfung: Stempelzeiten konnten nicht geladen werden (${error.message})`);
    const zeilen = (data ?? []) as Zeile[];
    for (const z of zeilen) {
      let liste = eintraegeJePerson.get(z.user_id);
      if (!liste) {
        liste = [];
        eintraegeJePerson.set(z.user_id, liste);
      }
      liste.push({ start: z.clock_in, ende: z.clock_out });
    }
    if (zeilen.length < SEITE) break;
  }

  for (const id of ids) {
    const wochen = stempelMinutenJeWoche(eintraegeJePerson.get(id) ?? []);
    const jeMonat = new Map<string, NbuStatus>();
    for (const m of monate) jeMonat.set(monatsSchluessel(m.jahr, m.monat), nbuStatusFuerMonat(wochen, m.jahr, m.monat));
    ergebnis.set(id, jeMonat);
  }
  return ergebnis;
}

/** NBU-Status einer Person fuer einen Abrechnungsmonat (Profil-Monat). */
export async function ladeNbuStatusFuerMonat(
  client: SupabaseClient,
  profileId: string,
  jahr: number,
  monat: number,
): Promise<NbuStatus> {
  const alle = await ladeNbuStatus(client, [profileId], [{ jahr, monat }]);
  return alle.get(profileId)?.get(monatsSchluessel(jahr, monat)) ?? { ...NBU_STATUS_KEINE_ARBEIT };
}

/** Abzugssaetze mit angewandter NBU-Regel: nicht versichert → NBU 0 %. */
export function mitNbuRegel<T extends { nbuPct: number }>(saetze: T, status: Pick<NbuStatus, "versichert">): T {
  return status.versichert ? saetze : { ...saetze, nbuPct: 0 };
}

/** Ø-Stunden fuer Anzeigen: eine Nachkommastelle, ABGERUNDET — sonst
 *  stuende bei 7.96 h «Ø 8.0 h … (unter 8 h)». Dezimalpunkt wie die
 *  uebrigen Lohn-Anzeigen. */
export function fmtNbuStunden(stunden: number): string {
  return (Math.floor(stunden * 10 + 1e-9) / 10).toFixed(1);
}

/** Begruendung in einem Satz (PDF, Tabellen-Tooltip, Lohn-Details), z. B.
 *  «nicht versichert — Ø 3.2 h pro Arbeitswoche (unter 8 h)». */
export function nbuBegruendung(status: NbuStatus): string {
  if (status.gearbeiteteWochen === 0) {
    return `nicht versichert — keine Arbeitswoche in den letzten ${NBU_BETRACHTUNG_MONATE} Monaten`;
  }
  const schnitt = `Ø ${fmtNbuStunden(status.durchschnittStundenProWoche)} h pro Arbeitswoche`;
  if (!status.versichert) return `nicht versichert — ${schnitt} (unter ${NBU_MIN_STUNDEN_PRO_WOCHE} h)`;
  if (status.regel === "mehrheit") {
    return `versichert — ${status.wochenAb8h} von ${status.gearbeiteteWochen} Arbeitswochen mit mindestens ${NBU_MIN_STUNDEN_PRO_WOCHE} h`;
  }
  return `versichert — ${schnitt}`;
}

export type AbzugSchluessel = "AHV_IV_EO" | "ALV" | "NBU" | "BVG" | "KTG" | "Quellensteuer";

export interface AbzugZeile {
  schluessel: AbzugSchluessel;
  /** Angewandter Satz in % (NBU: 0, wenn nicht versichert). */
  pct: number;
  betrag: number;
}

export interface MitarbeiterAbzuege {
  zeilen: AbzugZeile[];
  /** Summe der angewandten Saetze in %. */
  totalPct: number;
  total: number;
  netto: number;
}

/** Mitarbeiter-Abzuege vom Brutto mit NBU-Regel — die Berechnung der
 *  Lohnabrechnung (PDF), separat testbar. */
export function berechneMitarbeiterAbzuege(
  brutto: number,
  saetze: LohnPctSet,
  nbu: Pick<NbuStatus, "versichert">,
): MitarbeiterAbzuege {
  const s = mitNbuRegel(saetze, nbu);
  const roh: [AbzugSchluessel, number][] = [
    ["AHV_IV_EO", s.ahvIvEoPct],
    ["ALV", s.alvPct],
    ["NBU", s.nbuPct],
    ["BVG", s.bvgPct],
    ["KTG", s.ktgPct],
    ["Quellensteuer", s.quellensteuerPct],
  ];
  const zeilen = roh.map(([schluessel, pct]) => ({ schluessel, pct, betrag: (brutto * pct) / 100 }));
  const total = zeilen.reduce((t, z) => t + z.betrag, 0);
  return { zeilen, totalPct: sumEmployeePct(s), total, netto: brutto - total };
}
