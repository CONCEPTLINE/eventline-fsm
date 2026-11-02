// Getränke-Catering — Zeitangaben in Stunden (Eingabe und Anzeige); gespeichert und gerechnet wird in Minuten.

/** Minuten → Stundentext mit höchstens 2 Nachkommastellen, ohne überflüssige Nullen: 45 → «0.75», 90 → «1.5», 60 → «1», 20 → «0.33». */
export function minutenZuStunden(min: number): string {
  return String(Math.round((min / 60) * 100) / 100);
}

/** Stundentext → ganze Minuten («0.75» → 45, «1,5» → 90, «3.58» → 215). Ungültig, leer oder negativ → null. */
export function stundenZuMinuten(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  const h = Number(t);
  if (!Number.isFinite(h) || h < 0) return null;
  return Math.round(h * 60);
}

/** Für Verträge und Anzeige, Einheit ausgeschrieben (kein Punkt am Satzende): «0.75 Stunden», genau 1 → «1 Stunde». */
export function formatStunden(min: number): string {
  return min === 60 ? "1 Stunde" : `${minutenZuStunden(min)} Stunden`;
}
