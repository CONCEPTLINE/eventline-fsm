// Stempel-Bereich je Lohnmonat (für /api/flow/stempel: welche Stempel Trust flow
// für einen Monat bekommt).

import { monatAusIndex, monatIndex, monatsErster, monatsLetzter, plusTage } from "./zeit";

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
