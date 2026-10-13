/**
 * Lohn-Seite (/lohn): Ansicht und Bereiche samt URL-Schluesseln.
 *
 *   /lohn?ansicht=meine|team&tab=monatsstunden|dokumente|mitarbeiter|standardwerte
 *
 * Geteilt von der Seite selbst (liest/schreibt die URL) und der
 * /hr-Weiterleitung (bildet alte Hub-Links /hr?tab=loehne&lohn=…&subtab=…
 * darauf ab) — damit beide dieselben Schluessel kennen.
 */

export type LohnAnsicht = "meine" | "team";
export type LohnBereich = "monatsstunden" | "dokumente" | "mitarbeiter" | "standardwerte";

/** URL-Parameter fuer die Ansicht (Meine | Team). */
export const LOHN_PARAM_ANSICHT = "ansicht";
/** URL-Parameter fuer den Bereich innerhalb der Team-Ansicht. */
export const LOHN_PARAM_BEREICH = "tab";

const BEREICHE: readonly LohnBereich[] = ["monatsstunden", "dokumente", "mitarbeiter", "standardwerte"];

/** Fruehere Schluessel (Hub-Untertabs, aeltere Deep-Links) → heutiger Bereich. */
const BEREICH_ALIAS: Record<string, LohnBereich> = {
  pdfs: "dokumente",
  lohnabrechnungen: "dokumente",
  abrechnung: "monatsstunden",
  "mitarbeiter-lohn": "mitarbeiter",
};

export function resolveLohnBereich(raw: string | null): LohnBereich | null {
  if (!raw) return null;
  if ((BEREICHE as readonly string[]).includes(raw)) return raw as LohnBereich;
  return BEREICH_ALIAS[raw] ?? null;
}

export function resolveLohnAnsicht(raw: string | null): LohnAnsicht | null {
  return raw === "meine" || raw === "team" ? raw : null;
}
