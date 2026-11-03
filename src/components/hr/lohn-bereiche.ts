/**
 * Lohn-Seite (/lohn) und alte Links auf die frühere Team-Ansicht.
 *
 * /lohn ist für alle dieselbe Seite (?jahr=YYYY). Die Team-Ansicht
 * (/lohn?ansicht=team&tab=monatsstunden|dokumente|mitarbeiter|standardwerte)
 * gibt es nicht mehr: das Prüfen der Monatsstunden liegt unter
 * Stempelzeiten › Prüfen (/stempelzeiten?ansicht=pruefen&monat=YYYY-MM).
 *
 * Geteilt von /lohn (leitet alte Team-Links um) und der /hr-Weiterleitung
 * (alte Hub-Links /hr?tab=loehne&lohn=…&subtab=…).
 */

export type LohnAnsicht = "meine" | "team";

/** URL-Parameter der früheren Ansicht (Meine | Team) — nur noch für alte Links. */
export const LOHN_PARAM_ANSICHT = "ansicht";

/** Stempelzeiten › Prüfen: Ansicht-Parameter und Wert. */
export const STEMPEL_PARAM_ANSICHT = "ansicht";
export const STEMPEL_ANSICHT_PRUEFEN = "pruefen";

export function resolveLohnAnsicht(raw: string | null): LohnAnsicht | null {
  return raw === "meine" || raw === "team" ? raw : null;
}

/** Ziel eines alten Team-Links: Stempelzeiten › Prüfen, optional mit Monat (YYYY-MM). */
export function teamLinkZiel(monat?: string | null): string {
  const m = monat && /^\d{4}-(0[1-9]|1[0-2])$/.test(monat) ? `&monat=${monat}` : "";
  return `/stempelzeiten?${STEMPEL_PARAM_ANSICHT}=${STEMPEL_ANSICHT_PRUEFEN}${m}`;
}
