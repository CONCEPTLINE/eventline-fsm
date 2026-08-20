// Helper fuer Projekte: Minuten <-> Stunden-Anzeige, Fortschritts-Farbe.

export function minutesToHoursDecimal(m: number | null | undefined): number {
  return Math.round(((m ?? 0) / 60) * 100) / 100;
}

/** "3.5 h" fuer 210 min. Nutzt de-CH-Format (Komma-Dezimal). */
export function formatHours(m: number | null | undefined): string {
  const h = minutesToHoursDecimal(m);
  return `${h.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h`;
}

/** Fortschritt in Prozent (0-100+). Wenn budget=0 → 0. */
export function progressPct(usedMinutes: number, budgetHours: number | null | undefined): number {
  if (!budgetHours || budgetHours <= 0) return 0;
  return (usedMinutes / 60 / budgetHours) * 100;
}

/** Klassen-Farbe fuer Progress-Bar je nach Auslastung.
 *  <80% grün, 80-99% amber, ≥100% rot. */
export function progressColorClass(pct: number): string {
  if (pct >= 100) return "bg-red-500";
  if (pct >= 80) return "bg-amber-500";
  return "bg-green-500";
}

export const PROJECT_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  angefragt:      { label: "Angefragt",      color: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
  genehmigt:      { label: "Genehmigt",      color: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300" },
  abgelehnt:      { label: "Abgelehnt",      color: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
  abgeschlossen:  { label: "Abgeschlossen",  color: "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300" },
};
