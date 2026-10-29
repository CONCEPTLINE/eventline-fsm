// Lohn-Monate: welche Monate sind gesperrt (abgerechnet)?
//
// Ein Monat ist ab dem 5. des Folgemonats (00:00 Europe/Zurich) gesperrt —
// dieselbe Regel wie public.is_time_entry_locked (Migration 214) und
// src/lib/time-lock.ts. Erst dann sind die Stempel endgültig und eine
// Lohnabrechnung darf entstehen (Phase 1, Befund 2 «halbe Abrechnung»).
//
// Reine Funktionen (ohne DB, ohne Uhr) — `heute` wird übergeben, damit Tests
// und der Lauf mit einem festen Datum rechnen können. Der Server prüft vor
// dem Erzeugen zusätzlich mit der DB-Funktion (gleiche Uhr wie die Sperre).

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

export function vergleicheMonat(a: LohnMonat, b: LohnMonat): number {
  return a.jahr !== b.jahr ? a.jahr - b.jahr : a.monat - b.monat;
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

/** Ist der Monat am Tag `heuteIso` (YYYY-MM-DD, Zurich) gesperrt? */
export function istMonatGesperrt(m: LohnMonat, heuteIso: string): boolean {
  if (!Number.isInteger(m.jahr) || !Number.isInteger(m.monat) || m.monat < 1 || m.monat > 12) return false;
  return heuteIso >= sperrtAb(m);
}

/** Jüngster gesperrter Monat am Tag `heuteIso` — Vorgabe fürs Generieren. */
export function letzterGesperrterMonat(heuteIso: string): LohnMonat {
  const { y, m, d } = teile(heuteIso);
  // Ab dem 5. ist der Vormonat gesperrt, davor erst der Vorvormonat.
  const zurueck = d >= 5 ? 1 : 2;
  let jahr = y;
  let monat = m - zurueck;
  while (monat < 1) {
    monat += 12;
    jahr -= 1;
  }
  return { jahr, monat };
}

/** Alle gesperrten Monate von `ab` (inklusive) bis zum letzten gesperrten,
 *  aufsteigend. Leer, wenn `ab` noch nicht gesperrt ist. */
export function gesperrteMonateAb(ab: LohnMonat, heuteIso: string): LohnMonat[] {
  const bis = letzterGesperrterMonat(heuteIso);
  const out: LohnMonat[] = [];
  let m = { ...ab };
  while (vergleicheMonat(m, bis) <= 0) {
    out.push(m);
    m = naechsterMonat(m);
  }
  return out;
}

/** Die letzten `anzahl` gesperrten Monate, neuester zuerst (Auswahl im UI). */
export function letzteGesperrteMonate(heuteIso: string, anzahl: number): LohnMonat[] {
  const out: LohnMonat[] = [];
  let m = letzterGesperrterMonat(heuteIso);
  for (let i = 0; i < anzahl; i++) {
    out.push(m);
    m = m.monat === 1 ? { jahr: m.jahr - 1, monat: 12 } : { jahr: m.jahr, monat: m.monat - 1 };
  }
  return out;
}

const MONATSNAMEN = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** «September 2026» */
export function monatLabel(m: LohnMonat): string {
  return `${MONATSNAMEN[m.monat - 1]} ${m.jahr}`;
}
