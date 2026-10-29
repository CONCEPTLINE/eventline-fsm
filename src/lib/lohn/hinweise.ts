// Kurztexte zu Lohnregeln für Anzeigen (Browser und Server, ohne Logik).
// Die Regeln selbst stehen im Rechenkern (src/lib/lohn/kern).

import { NBU_MIN_STUNDEN_PRO_WOCHE } from "./kern/regeln";

/** Kurzer Hinweis für Stellen, die den NBU-Satz nur als Stammdatum zeigen. */
export const NBU_HINWEIS_KURZ = `wird nur abgezogen, wenn Ø ≥ ${NBU_MIN_STUNDEN_PRO_WOCHE} h/Woche`;

/** Ausführlicher Hinweis (Tooltip) — Empfehlung 7/87 (Rev. 2019), Art. 13 UVV. */
export const NBU_HINWEIS_LANG =
  `Art. 13 UVV / Empfehlung 7/87: NBU-versichert ist, wer bei EVENTLINE im Schnitt mindestens ${NBU_MIN_STUNDEN_PRO_WOCHE} Stunden pro Woche arbeitet. ` +
  "Massgebend sind die letzten 3 oder 12 Monate bis Ende des Abrechnungsmonats (die günstigere Variante), nur ganze Wochen; " +
  "überwiegen die Wochen mit Arbeit, zählen nur diese, sonst alle Wochen. Sonst kein NBU-Abzug (Arbeitsweg-Unfälle gelten dann als Berufsunfall).";

/** Mindestalter für eine Anstellung (Entscheid Mischa/Leo 29.10.2026). */
export const MINDESTALTER_ANSTELLUNG = 18;

/** Warnung, wenn die Person am Stichtag (YYYY-MM-DD) jünger als 18 ist, sonst null. */
export function alterWarnung(geburtsdatum: string | null | undefined, stichtag: string): string | null {
  if (!geburtsdatum || !/^\d{4}-\d{2}-\d{2}$/.test(geburtsdatum) || !/^\d{4}-\d{2}-\d{2}$/.test(stichtag)) return null;
  const [gj, gm, gt] = geburtsdatum.split("-").map(Number);
  const [sj, sm, st] = stichtag.split("-").map(Number);
  const alter = sj - gj - (sm < gm || (sm === gm && st < gt) ? 1 : 0);
  return alter < MINDESTALTER_ANSTELLUNG
    ? `Achtung: Die Person ist am ${st}.${sm}.${sj} erst ${alter} Jahre alt — EVENTLINE stellt nur ab ${MINDESTALTER_ANSTELLUNG} Jahren an.`
    : null;
}
