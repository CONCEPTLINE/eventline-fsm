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
  storniert:      { label: "Storniert",      color: "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300" },
};

/** Endzustaende = "Archiv". Aktivliste zeigt alles andere. */
export const PROJECT_ARCHIVE_STATUSES: readonly string[] = ["abgeschlossen", "abgelehnt", "storniert"];

// ── Zeitraum ─────────────────────────────────────────────────────────
// projects.start_date/end_date sind DATE-Spalten, Supabase liefert sie
// als "YYYY-MM-DD". Vergleiche laufen deshalb als String-Vergleich —
// ISO-Datumsstrings sortieren lexikografisch korrekt und umgehen jede
// Zeitzonen-Frage. Nur fuer die ANZEIGE wird in ein Date konvertiert.

/** "YYYY-MM-DD" → Date. Anker auf 12:00 statt Mitternacht, weil
 *  new Date("2026-09-12") als UTC gelesen wird und in CET/CEST auf den
 *  Vortag zurueckrollt. */
export function parseDateOnly(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

/** "12.09.2026" */
export function formatDateOnly(iso: string): string {
  return parseDateOnly(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });
}

/** Zeitraum als eine Zeile: "12.09. – 18.09.2026", "ab 12.09.2026",
 *  "bis 18.09.2026". null wenn gar kein Datum gesetzt ist. */
export function formatProjectRange(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  if (start && !end) return `ab ${formatDateOnly(start)}`;
  if (!start && end) return `bis ${formatDateOnly(end!)}`;
  const s = parseDateOnly(start!);
  const e = parseDateOnly(end!);
  // Gleiches Jahr → Jahreszahl nur einmal am Ende.
  const sStr = s.getFullYear() === e.getFullYear()
    ? s.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit" })
    : formatDateOnly(start!);
  return `${sStr} – ${formatDateOnly(end!)}`;
}

/** Anzahl Kalendertage inkl. Start- und Endtag. null wenn unvollstaendig. */
export function projectDurationDays(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = parseDateOnly(end).getTime() - parseDateOnly(start).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

export type ProjectPhaseKey = "geplant" | "laeuft" | "beendet" | "ueberfaellig";

export interface ProjectPhase {
  key: ProjectPhaseKey;
  label: string;
  /** Chip-Klassen, gleiche Optik wie PROJECT_STATUS_LABEL. */
  color: string;
}

const PHASE: Record<ProjectPhaseKey, ProjectPhase> = {
  geplant:      { key: "geplant",      label: "Geplant",      color: "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300" },
  laeuft:       { key: "laeuft",       label: "Läuft",        color: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300" },
  beendet:      { key: "beendet",      label: "Zeitraum vorbei", color: "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300" },
  ueberfaellig: { key: "ueberfaellig", label: "Überfällig",   color: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
};

/**
 * Zeitliche Phase eines Projekts — abgeleitet aus den Daten, NICHT
 * gepflegt. Bewusst getrennt vom Status (angefragt/genehmigt/...): der
 * Status sagt, ob Budget freigegeben ist, die Phase sagt, wo im
 * Zeitplan das Projekt steht.
 *
 * "Überfällig" nur wenn das Projekt noch offen ist — ein abgeschlossenes
 * oder storniertes Projekt mit vergangenem Enddatum ist kein Problem.
 *
 * Gibt null zurueck wenn kein Startdatum gesetzt ist; dann zeigt die UI
 * gar keine Phase statt einer geratenen.
 */
export function projectPhase(
  start: string | null,
  end: string | null,
  status: string,
  today: string,
): ProjectPhase | null {
  if (!start && !end) return null;
  const isArchived = PROJECT_ARCHIVE_STATUSES.includes(status);

  if (end && end < today) {
    return isArchived ? PHASE.beendet : PHASE.ueberfaellig;
  }
  if (start && start > today) return PHASE.geplant;
  // Start erreicht (oder nur ein Enddatum in der Zukunft) → laeuft.
  return isArchived ? PHASE.beendet : PHASE.laeuft;
}

/** Zeit-Fortschritt im Zeitraum in Prozent (0-100). null wenn der
 *  Zeitraum unvollstaendig ist. Bewusst geklemmt: ein ueberfaelliges
 *  Projekt zeigt 100%, nicht 140%. */
export function timeProgressPct(start: string | null, end: string | null, today: string): number | null {
  if (!start || !end) return null;
  const s = parseDateOnly(start).getTime();
  const e = parseDateOnly(end).getTime();
  const t = parseDateOnly(today).getTime();
  if (e <= s) return t >= e ? 100 : 0;
  return Math.max(0, Math.min(100, ((t - s) / (e - s)) * 100));
}
