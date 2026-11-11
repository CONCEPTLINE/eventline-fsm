/**
 * Lohn-Seite (/lohn) und alte Links auf die frühere Team-Ansicht.
 *
 * /lohn ist für alle dieselbe Seite (?jahr=YYYY). Gerechnet wird der Lohn seit
 * November 2026 nur noch in Trust flow (Lohn-Abbau 11.11.2026, die befristete
 * Lohnverwaltung /lohn/verwaltung gibt es nicht mehr). Alte Team-Links
 * (/lohn?ansicht=team&tab=…, /hr?tab=lohn&lohn=team&subtab=…):
 *   - monatsstunden (oder ohne Reiter) → Stempelzeiten › Prüfen (?monat=YYYY-MM)
 *   - dokumente | mitarbeiter | standardwerte → /lohn
 *
 * Geteilt von /lohn, der /hr-Weiterleitung und Stempelzeiten (Ansicht Prüfen).
 */

export type LohnAnsicht = "meine" | "team";

/** URL-Parameter der früheren Ansicht (Meine | Team) — nur noch für alte Links. */
export const LOHN_PARAM_ANSICHT = "ansicht";
/** URL-Parameter des früheren Team-Reiters — nur noch für alte Links. */
export const LOHN_PARAM_BEREICH = "tab";

/** Stempelzeiten › Prüfen: Ansicht-Parameter und Wert. */
export const STEMPEL_PARAM_ANSICHT = "ansicht";
export const STEMPEL_ANSICHT_PRUEFEN = "pruefen";

/** Frühere Team-Reiter, die heute auf /lohn landen (die Werkzeuge gibt es nicht mehr). */
const FRUEHERE_VERWALTUNG = new Set(["dokumente", "mitarbeiter", "standardwerte", "pdfs", "lohnabrechnungen", "mitarbeiter-lohn"]);

export function resolveLohnAnsicht(raw: string | null): LohnAnsicht | null {
  return raw === "meine" || raw === "team" ? raw : null;
}

/** Ziel eines alten Team-Links: Monatsstunden (oder ohne Reiter) → Stempelzeiten › Prüfen,
 *  optional mit Monat (YYYY-MM); frühere Verwaltungs-Reiter → /lohn. */
export function teamLinkZiel(tab?: string | null, monat?: string | null): string {
  if (tab && FRUEHERE_VERWALTUNG.has(tab)) return "/lohn";
  const m = monat && /^\d{4}-(0[1-9]|1[0-2])$/.test(monat) ? `&monat=${monat}` : "";
  return `/stempelzeiten?${STEMPEL_PARAM_ANSICHT}=${STEMPEL_ANSICHT_PRUEFEN}${m}`;
}
