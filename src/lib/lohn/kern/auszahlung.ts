// Rechenkern Lohn — Auszahlungsdatum und Stempel-Bereich.
//
// Auszahlungsprinzip: Sätze und Jahr (AHV, Lohnausweis) richten sich nach dem
// Tag der Auszahlung. Der Lohn des Monats M wird im Folgemonat ausbezahlt
// (EVENTLINE: innert der ersten 5 Arbeitstage) — der Dezember-Lohn gehört
// damit ins Folgejahr.

import type { Feiertag } from "./typen";
import { monatAusIndex, monatIndex, monatsErster, monatsLetzter, plusTage, wochentag } from "./zeit";

/** n-ter Arbeitstag (Mo–Fr, ohne Feiertage) des Folgemonats von M. */
export function auszahlungsdatumNachRegel(jahr: number, monat: number, arbeitstag: number, feiertage: Feiertag[]): string {
  if (!Number.isInteger(arbeitstag) || arbeitstag < 1 || arbeitstag > 20) {
    throw new Error(`Auszahlung: ungültiger Arbeitstag ${arbeitstag}`);
  }
  const frei = new Set(feiertage.map((f) => f.datum));
  const f = monatAusIndex(monatIndex(jahr, monat) + 1);
  let d = monatsErster(f.jahr, f.monat);
  let n = 0;
  for (let i = 0; i < 40; i++) {
    const wt = wochentag(d);
    if (wt !== 0 && wt !== 6 && !frei.has(d)) {
      n++;
      if (n === arbeitstag) return d;
    }
    d = plusTage(d, 1);
  }
  throw new Error("Auszahlung: Arbeitstag nicht gefunden");
}

/**
 * Lokale Kalendertage, deren Stempel der Kern für Monat M braucht:
 *   - 12 Monate zurück (NBU) plus eine Woche Rand,
 *   - im Januar das ganze Vorjahr (die Nacht 31.12./1.1. zählt im Vorjahr),
 *   - bis einen Tag nach Monatsende (Schichten über Mitternacht).
 * Mehr Stempel schaden nicht.
 */
export function stempelBereich(jahr: number, monat: number): { von: string; bis: string } {
  const start12 = monatAusIndex(monatIndex(jahr, monat) - 11);
  const vonNbu = plusTage(monatsErster(start12.jahr, start12.monat), -7);
  const vonJahr = monat === 1 ? `${jahr - 1}-01-01` : `${jahr}-01-01`;
  const von = vonNbu < vonJahr ? vonNbu : vonJahr;
  return { von: plusTage(von, -1), bis: plusTage(monatsLetzter(jahr, monat), 1) };
}
