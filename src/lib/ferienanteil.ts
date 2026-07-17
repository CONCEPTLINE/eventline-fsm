/**
 * Ferienanteil-Berechnung gemaess Schweizer Arbeitsrecht (Art. 329a OR).
 *
 *   Bis zum vollendeten 20. Altersjahr (age <= 20): 5 Wochen -> 10.64%
 *   Danach (age >= 21):                              4 Wochen -> 8.33%
 *
 * Bei Stundenlohn ist der Ferienanteil typischerweise IM Stundenlohn
 * enthalten. Die Lohnabrechnung muss ihn separat ausweisen (Art. 329d OR
 * + BGE 116 II 515).
 *
 * Override pro Mitarbeiter moeglich via employee_compensation.
 * ferienanteil_pct_override (z.B. wenn ein MA per Vertrag 5 Wochen statt
 * 4 Wochen hat).
 */

export const FERIENANTEIL_ADULT_PCT = 8.33;   // 4/48 Wochen ~= 8.33%
export const FERIENANTEIL_YOUTH_PCT = 10.64;  // 5/47 Wochen ~= 10.64%

/** Alter zum Stichtag (in vollen Jahren). asOfIso = YYYY-MM-DD. */
export function ageAtDate(birthdateIso: string, asOfIso: string): number {
  const [by, bm, bd] = birthdateIso.split("-").map(Number);
  const [ay, am, ad] = asOfIso.split("-").map(Number);
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age--;
  return age;
}

/** Effektiver Ferienanteil in %. Reihenfolge:
 *  1. Override (employee_compensation.ferienanteil_pct_override) wenn gesetzt
 *  2. 10.64% bis zum vollendeten 20. Altersjahr (age <= 20)
 *  3. 8.33% sonst (Default fuer Erwachsene)
 *
 *  Wenn kein Geburtsdatum bekannt -> Erwachsenen-Default 8.33%.
 */
export function effectiveFerienanteil(
  override: number | null | undefined,
  birthdateIso: string | null | undefined,
  asOfIso: string,
): number {
  if (override != null) return Number(override);
  if (!birthdateIso) return FERIENANTEIL_ADULT_PCT;
  return ageAtDate(birthdateIso, asOfIso) <= 20
    ? FERIENANTEIL_YOUTH_PCT
    : FERIENANTEIL_ADULT_PCT;
}

/** Brutto-Aufspaltung in Grundlohn + Ferienanteil.
 *  brutto = grundlohn × (1 + ferienanteilPct/100)
 *  -> grundlohn = brutto / (1 + ferienanteilPct/100)
 *  -> ferienanteilTeil = brutto - grundlohn
 *
 *  Konvention: der gespeicherte Brutto-Stundenlohn ist INKLUSIVE
 *  Ferienanteil. PDF spaltet ihn fuer die Anzeige auf.
 */
export function splitBruttoFerien(brutto: number, ferienanteilPct: number): {
  grundlohn: number;
  ferienanteil: number;
} {
  const grundlohn = brutto / (1 + ferienanteilPct / 100);
  return { grundlohn, ferienanteil: brutto - grundlohn };
}
