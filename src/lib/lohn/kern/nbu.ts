// Rechenkern Lohn — NBU-Versicherung nach Empfehlung Ad-hoc-Kommission
// Schaden UVG Nr. 7/87 (Revision 5.4.2019), Art. 13 UVV.
//
// Versichert gegen Nichtberufsunfälle ist, wer bei EVENTLINE im Durchschnitt
// mindestens 8 Stunden pro Woche arbeitet. Für den Abrechnungsmonat M:
//   - Zeitraum 3 Monate (erster Tag M-2 bis letzter Tag M) ODER 12 Monate
//     (erster Tag M-11 bis letzter Tag M); die für die Person günstigere
//     Variante zählt (= versichert, sobald eine der beiden 8 h erreicht).
//   - Nur ganze Wochen (Montag–Sonntag, vollständig im Zeitraum), und nur
//     Wochen, die die Anstellung berühren.
//   - Überwiegen im Zeitraum die Wochen mit Arbeit, zählen nur diese;
//     sonst zählen alle Wochen.
//   - Keine «Mehrheit der 8-h-Wochen»-Regel (steht in der Revision 2019 nicht).
// Grundlage sind die effektiv gestempelten Minuten.

import type { Anstellung, NbuStatus, NbuVariante } from "./typen";
import { NBU_MIN_STUNDEN_PRO_WOCHE } from "./regeln";
import { monatAusIndex, monatIndex, monatsErster, monatsLetzter, plusTage, wochenMontag } from "./zeit";

function wocheBeruehrtAnstellung(montag: string, anstellungen: Anstellung[] | null): boolean {
  if (anstellungen == null) return true;
  const sonntag = plusTage(montag, 6);
  return anstellungen.some((a) => a.eintritt <= sonntag && (a.austritt == null || montag <= a.austritt));
}

/** Ganze Wochen (Montage) im Zeitraum [von, bis]. */
export function ganzeWochen(von: string, bis: string): string[] {
  let m = wochenMontag(von);
  if (m < von) m = plusTage(m, 7);
  const out: string[] = [];
  while (plusTage(m, 6) <= bis) {
    out.push(m);
    m = plusTage(m, 7);
  }
  return out;
}

export function nbuZeitraum(jahr: number, monat: number, monate: 3 | 12): { von: string; bis: string } {
  const start = monatAusIndex(monatIndex(jahr, monat) - (monate - 1));
  return { von: monatsErster(start.jahr, start.monat), bis: monatsLetzter(jahr, monat) };
}

function variante(
  monate: 3 | 12,
  jahr: number,
  monat: number,
  minutenJeWoche: ReadonlyMap<string, number>,
  anstellungen: Anstellung[] | null,
): NbuVariante {
  const { von, bis } = nbuZeitraum(jahr, monat, monate);
  const wochen = ganzeWochen(von, bis).filter((m) => wocheBeruehrtAnstellung(m, anstellungen));
  let minuten = 0;
  let arbeitswochen = 0;
  for (const m of wochen) {
    const w = minutenJeWoche.get(m) ?? 0;
    minuten += w;
    if (w > 0) arbeitswochen++;
  }
  const nurArbeitswochen = arbeitswochen > wochen.length - arbeitswochen;
  const nenner = nurArbeitswochen ? arbeitswochen : wochen.length;
  const durchschnittStunden = nenner > 0 ? minuten / nenner / 60 : 0;
  return {
    monate,
    von,
    bis,
    wochen: wochen.length,
    arbeitswochen,
    nurArbeitswochen,
    minuten,
    durchschnittStunden,
    erreicht: nenner > 0 && minuten >= NBU_MIN_STUNDEN_PRO_WOCHE * 60 * nenner,
  };
}

/** Ø-Stunden fürs Auge: eine Nachkommastelle, abgerundet (7.96 → «7.9», nicht «8.0»). */
export function fmtStundenAbgerundet(h: number): string {
  return (Math.floor(h * 10 + 1e-9) / 10).toFixed(1);
}

export function nbuStatus(
  jahr: number,
  monat: number,
  minutenJeWoche: ReadonlyMap<string, number>,
  anstellungen: Anstellung[] | null,
): NbuStatus {
  const v3 = variante(3, jahr, monat, minutenJeWoche, anstellungen);
  const v12 = variante(12, jahr, monat, minutenJeWoche, anstellungen);
  const versichert = v3.erreicht || v12.erreicht;
  const massgebend: 3 | 12 | null = v3.erreicht ? 3 : v12.erreicht ? 12 : null;
  const teil = (v: NbuVariante) =>
    v.wochen === 0
      ? `${v.monate} Monate: keine ganze Woche`
      : `${v.monate} Monate: Ø ${fmtStundenAbgerundet(v.durchschnittStunden)} h (${v.nurArbeitswochen ? `${v.arbeitswochen} Arbeitswochen` : `alle ${v.wochen} Wochen`})`;
  const begruendung = versichert
    ? `versichert — ${teil(massgebend === 3 ? v3 : v12)}, mindestens ${NBU_MIN_STUNDEN_PRO_WOCHE} h pro Woche`
    : `nicht versichert — ${teil(v3)}; ${teil(v12)}; unter ${NBU_MIN_STUNDEN_PRO_WOCHE} h pro Woche`;
  return { versichert, massgebend, varianten: [v3, v12], begruendung };
}
