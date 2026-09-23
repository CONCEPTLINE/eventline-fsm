// Gemeinsame Anzeige-Helfer fuer /entwuerfe (Liste + Detail). Vorher waren
// Status-Chip-Map und formatDateRange in beiden Seiten wortgleich dupliziert
// (Skalierbarkeits-Audit 2026-09-23) — Aenderungen an Farben/Labels haetten
// still auseinanderlaufen koennen.

export type DraftStatus = "aktiv" | "wartet_auf_kunde" | "storniert" | "umgewandelt";

export const DRAFT_STATUS_CHIP: Record<DraftStatus, { label: string; color: string }> = {
  aktiv: { label: "Aktiv", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300" },
  wartet_auf_kunde: { label: "Wartet auf Kunde", color: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" },
  storniert: { label: "Storniert", color: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
  umgewandelt: { label: "Umgewandelt", color: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300" },
};

/** "14.6.2026 – 15.6.2026" (de-CH, Europe/Zurich). Mittag-Anker gegen
 *  Datums-Kipp-Bugs. `empty` = Anzeige wenn beide Daten fehlen
 *  (Liste nutzt "", Detail "—"). */
export function formatDateRange(from: string | null, to: string | null, empty = ""): string {
  if (!from && !to) return empty;
  const fmt = (iso: string) =>
    new Date(iso + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });
  if (from && to && from !== to) return `${fmt(from)} – ${fmt(to)}`;
  return fmt(from ?? to!);
}
