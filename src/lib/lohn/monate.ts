// Lohn-Monate: welche Monate sind gesperrt (abgerechnet)?
//
// Ein Monat ist ab dem 5. des Folgemonats (00:00 Europe/Zurich) gesperrt —
// dieselbe Regel wie public.is_time_entry_locked (Migration 214) und
// src/lib/time-lock.ts. Erst dann sind die Stempel endgültig (Trust flow
// rechnet den Lohn).
//
// Reine Funktionen (ohne DB, ohne Uhr).

export interface LohnMonat {
  jahr: number;
  monat: number; // 1–12
}

const ISO_TAG = /^(\d{4})-(\d{2})-(\d{2})$/;

function teile(heuteIso: string): { y: number; m: number; d: number } {
  const t = ISO_TAG.exec(heuteIso);
  if (!t) throw new Error(`Datum ungültig: ${heuteIso}`);
  return { y: Number(t[1]), m: Number(t[2]), d: Number(t[3]) };
}

/** "YYYY-MM" */
export function monatSchluessel(m: LohnMonat): string {
  return `${m.jahr}-${String(m.monat).padStart(2, "0")}`;
}

/** "YYYY-MM-01" */
export function monatsErster(m: LohnMonat): string {
  return `${monatSchluessel(m)}-01`;
}

/** Letzter Kalendertag des Monats "YYYY-MM-DD". */
export function monatsLetzter(m: LohnMonat): string {
  const tage = new Date(Date.UTC(m.jahr, m.monat, 0)).getUTCDate();
  return `${monatSchluessel(m)}-${String(tage).padStart(2, "0")}`;
}

export function naechsterMonat(m: LohnMonat): LohnMonat {
  return m.monat === 12 ? { jahr: m.jahr + 1, monat: 1 } : { jahr: m.jahr, monat: m.monat + 1 };
}

/** Monat eines KALENDERDATUMS "YYYY-MM-DD" (Spalte vom Typ date, kein
 *  Zeitstempel — dafür localDateIso aus swiss-time nehmen). */
export function monatVon(datum: string): LohnMonat {
  const { y, m } = teile(datum);
  return { jahr: y, monat: m };
}

/** Ab diesem Tag (Zurich) ist der Monat gesperrt: 5. des Folgemonats. */
export function sperrtAb(m: LohnMonat): string {
  return `${monatSchluessel(naechsterMonat(m))}-05`;
}

const MONATSNAMEN = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** «September 2026» */
export function monatLabel(m: LohnMonat): string {
  return `${MONATSNAMEN[m.monat - 1]} ${m.jahr}`;
}
