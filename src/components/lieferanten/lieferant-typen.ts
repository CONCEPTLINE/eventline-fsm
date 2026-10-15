// Kategorien der Lieferanten-Firmen (Spalte lieferanten.type) — EINE Quelle
// fuer die Lieferanten-Seite (Badge, Formular) und Einstellungen ›
// Lieferantenportal (Sublabel im Firmen-Dropdown).
// Color-Konvention: lila ist app-weit IT-Tickets, gruen ist Stempel.
export const LIEFERANT_TYPES = {
  catering: { label: "Catering", color: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300" },
  technik: { label: "Technik", color: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300" },
  av: { label: "AV / Sound", color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" },
  mobiliar: { label: "Mobiliar", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-300" },
  reinigung: { label: "Reinigung", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300" },
  security: { label: "Security", color: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300" },
  logistik: { label: "Logistik", color: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300" },
  sonstiges: { label: "Sonstiges", color: "bg-zinc-100 text-zinc-700 dark:bg-zinc-500/15 dark:text-zinc-300" },
} as const;

export type LieferantType = keyof typeof LIEFERANT_TYPES;

/** Anzeige-Label; unbekannte Slugs fallen auf den Roh-Slug zurueck. */
export function lieferantTypLabel(type: string | null | undefined): string | undefined {
  if (!type) return undefined;
  return (LIEFERANT_TYPES as Record<string, { label: string }>)[type]?.label ?? type;
}
