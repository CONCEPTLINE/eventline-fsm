// Text- und Datums-Helfer des Dashboards. Alles im Europe/Zurich-Kalender
// (CLAUDE.md §4) — Wochentags-/Monatsnamen als feste Listen, damit die
// Anzeige nicht von der Locale-Variante des Browsers abhaengt.

import { localDateIso, localHour, localTimeHM, plusTage, todayLocalIso, weekdayForDateIso } from "@/lib/swiss-time";

const WT_KURZ = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;
const WT_LANG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"] as const;
const MONAT_LANG = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
] as const;
const MONAT_KURZ = ["JAN", "FEB", "MÄR", "APR", "MAI", "JUN", "JUL", "AUG", "SEP", "OKT", "NOV", "DEZ"] as const;
const ZAHLWORT = ["Keine", "Eine", "Zwei", "Drei", "Vier", "Fünf", "Sechs", "Sieben", "Acht", "Neun", "Zehn", "Elf", "Zwölf"] as const;

const nf0 = new Intl.NumberFormat("de-CH", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function tageZwischen(a: string, b: string): number {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

/** «Samstag, 3. Oktober 2026» */
export function datumLang(jetzt: Date): string {
  const iso = localDateIso(jetzt);
  const [y, m, d] = iso.split("-").map(Number);
  return `${WT_LANG[weekdayForDateIso(iso)]}, ${d}. ${MONAT_LANG[m - 1]} ${y}`;
}

/** Gruss nach Zurich-Tageszeit. */
export function gruss(jetzt: Date): string {
  const h = localHour(jetzt);
  if (h < 12) return "Guten Morgen";
  if (h < 17) return "Guten Tag";
  return "Guten Abend";
}

/** «Eine», «Zwei» … «Zwölf», darueber Ziffern (fuer den Satzanfang). */
export function zahlwort(n: number): string {
  return ZAHLWORT[n] ?? String(n);
}

export function monatName(yyyyMm: string): string {
  const m = Number(yyyyMm.slice(5, 7));
  return MONAT_LANG[m - 1] ?? "";
}

/** Datums-Kachel fuer einen Zurich-Tag YYYY-MM-DD: «FR» / «02» / «OKT». */
export function datumKachelTag(isoDatum: string): { wochentag: string; tag: string; monat: string } {
  const m = Number(isoDatum.slice(5, 7));
  return {
    wochentag: WT_KURZ[weekdayForDateIso(isoDatum)].toUpperCase(),
    tag: isoDatum.slice(8, 10),
    monat: MONAT_KURZ[m - 1],
  };
}

/** Datums-Kachel des naechsten Einsatzes (ISO-Zeitpunkt): «FR» / «02» / «OKT». */
export function datumKachel(isoZeit: string): { wochentag: string; tag: string; monat: string } {
  return datumKachelTag(localDateIso(new Date(isoZeit)));
}

/** «Heute» / «Morgen» / «Dienstag» fuer einen Zurich-Tag YYYY-MM-DD;
 *  liegt der Tag zurueck (laufender Auftrag): «seit Do 1.10.». */
export function tagText(isoDatum: string): string {
  const heute = todayLocalIso();
  if (isoDatum === heute) return "Heute";
  if (isoDatum === plusTage(heute, 1)) return "Morgen";
  if (isoDatum < heute) return `seit ${tagKurz(isoDatum)}`;
  return WT_LANG[weekdayForDateIso(isoDatum)];
}

/** «Heute» / «Morgen» / «Dienstag» — der Tag steht daneben in der Kachel. */
export function einsatzTag(isoZeit: string): string {
  return tagText(localDateIso(new Date(isoZeit)));
}

/** Fuer den Kopf-Satz: «heute» / «morgen» / «am Dienstag» / «am 14. Oktober». */
export function einsatzTagImSatz(isoZeit: string): string {
  const tag = localDateIso(new Date(isoZeit));
  const heute = todayLocalIso();
  if (tag === heute) return "heute";
  if (tag === plusTage(heute, 1)) return "morgen";
  if (tageZwischen(heute, tag) < 7) return `am ${WT_LANG[weekdayForDateIso(tag)]}`;
  const [, m, d] = tag.split("-").map(Number);
  return `am ${d}. ${MONAT_LANG[m - 1]}`;
}

/** «HH:MM» (Zurich). */
export function uhrzeit(isoZeit: string): string {
  return localTimeHM(new Date(isoZeit));
}

/** «18:00 – 23:30»; endet der Einsatz erst nach dem Folgetag: «18:00 – 4.10. 02:00». */
export function zeitspanne(start: string, ende: string | null): string {
  const s = uhrzeit(start);
  if (!ende) return s;
  const e = uhrzeit(ende);
  const sTag = localDateIso(new Date(start));
  const eTag = localDateIso(new Date(ende));
  if (eTag === sTag || eTag === plusTage(sTag, 1)) return `${s} – ${e}`;
  const [, m, d] = eTag.split("-").map(Number);
  return `${s} – ${d}.${m}. ${e}`;
}

/** «Fr 9.10.» fuer einen Zurich-Tag YYYY-MM-DD. */
export function tagKurz(isoDatum: string): string {
  const [, m, d] = isoDatum.split("-").map(Number);
  return `${WT_KURZ[weekdayForDateIso(isoDatum)]} ${d}.${m}.`;
}

/** Abwesend bis (letzter Tag, inklusiv): «bis heute» / «bis Fr 9.10.». */
export function abwesendBis(isoDatum: string | null): string {
  if (!isoDatum) return "";
  if (isoDatum === todayLocalIso()) return "bis heute";
  return `bis ${tagKurz(isoDatum)}`;
}

export function ueberfaelligSeit(tage: number): string {
  if (tage <= 0) return "heute fällig";
  if (tage === 1) return "seit 1 Tag";
  return `seit ${tage} Tagen`;
}

/** Stunden mit einer Nachkommastelle: «12.5». */
export function stunden1(h: number): string {
  return nf1.format(h);
}

/** Ganzzahl mit Schweizer Tausendertrennung: «2’820». */
export function ganzzahl(n: number): string {
  return nf0.format(Math.round(n));
}
