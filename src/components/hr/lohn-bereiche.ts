/**
 * Lohn-Seite (/lohn), befristete Lohnverwaltung (/lohn/verwaltung) und alte
 * Links auf die frühere Team-Ansicht.
 *
 * /lohn ist für alle dieselbe Seite (?jahr=YYYY). Die frühere Team-Ansicht
 * (/lohn?ansicht=team&tab=monatsstunden|dokumente|mitarbeiter|standardwerte)
 * ist aufgeteilt:
 *   - monatsstunden → Stempelzeiten › Prüfen (/stempelzeiten?ansicht=pruefen&monat=YYYY-MM)
 *   - dokumente | mitarbeiter | standardwerte → /lohn/verwaltung?tab=…
 *     (befristet bis nach dem Lohnlauf November 2026, entfällt in Phase 2)
 *
 * Geteilt von /lohn (leitet alte Team-Links um), /lohn/verwaltung, der
 * /hr-Weiterleitung (alte Hub-Links /hr?tab=loehne&lohn=…&subtab=…), dem
 * Lohnlauf (Meldungen) und der Befehlspalette.
 */

export type LohnAnsicht = "meine" | "team";
/** Reiter der befristeten Lohnverwaltung. */
export type VerwaltungBereich = "dokumente" | "mitarbeiter" | "standardwerte";

/** URL-Parameter der früheren Ansicht (Meine | Team) — nur noch für alte Links. */
export const LOHN_PARAM_ANSICHT = "ansicht";
/** URL-Parameter des Bereichs (früher Team-Reiter, heute Reiter der Lohnverwaltung). */
export const LOHN_PARAM_BEREICH = "tab";

/** Stempelzeiten › Prüfen: Ansicht-Parameter und Wert. */
export const STEMPEL_PARAM_ANSICHT = "ansicht";
export const STEMPEL_ANSICHT_PRUEFEN = "pruefen";

const VERWALTUNG: readonly VerwaltungBereich[] = ["dokumente", "mitarbeiter", "standardwerte"];

/** Frühere Schlüssel (Hub-Untertabs, ältere Deep-Links) → heutiger Bereich. */
const BEREICH_ALIAS: Record<string, VerwaltungBereich | "monatsstunden"> = {
  pdfs: "dokumente",
  lohnabrechnungen: "dokumente",
  abrechnung: "monatsstunden",
  "mitarbeiter-lohn": "mitarbeiter",
};

/** Bereich aus einem (alten) Link: ein Verwaltungs-Reiter, «monatsstunden» oder null. */
export function resolveLohnBereich(raw: string | null): VerwaltungBereich | "monatsstunden" | null {
  if (!raw) return null;
  if (raw === "monatsstunden") return "monatsstunden";
  if ((VERWALTUNG as readonly string[]).includes(raw)) return raw as VerwaltungBereich;
  return BEREICH_ALIAS[raw] ?? null;
}

/** Reiter der Lohnverwaltung aus der URL (unbekannt/fehlend → null). */
export function resolveVerwaltungBereich(raw: string | null): VerwaltungBereich | null {
  const b = resolveLohnBereich(raw);
  return b && b !== "monatsstunden" ? b : null;
}

export function resolveLohnAnsicht(raw: string | null): LohnAnsicht | null {
  return raw === "meine" || raw === "team" ? raw : null;
}

/** Link auf die befristete Lohnverwaltung (Vorgabe: Lohndokumente). */
export function verwaltungLink(bereich: VerwaltungBereich = "dokumente"): string {
  return `/lohn/verwaltung?${LOHN_PARAM_BEREICH}=${bereich}`;
}

/** Ziel eines alten Team-Links: Verwaltungs-Reiter → /lohn/verwaltung, sonst
 *  (Monatsstunden, ohne Reiter) Stempelzeiten › Prüfen, optional mit Monat (YYYY-MM). */
export function teamLinkZiel(tab?: string | null, monat?: string | null): string {
  const b = resolveLohnBereich(tab ?? null);
  if (b && b !== "monatsstunden") return verwaltungLink(b);
  const m = monat && /^\d{4}-(0[1-9]|1[0-2])$/.test(monat) ? `&monat=${monat}` : "";
  return `/stempelzeiten?${STEMPEL_PARAM_ANSICHT}=${STEMPEL_ANSICHT_PRUEFEN}${m}`;
}
