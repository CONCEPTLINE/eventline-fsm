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
