/**
 * /datenbank → Weiterleitung. Der fruehere Kunden/Lieferanten-Hub ist
 * aufgeloest (Struktur-Umbau 2026-10): Kunden, Locations und Lieferanten
 * sind eigene Eintraege unter «Kontakte». Alte Links bleiben gueltig:
 *   ?tab=lieferanten|lieferant                  → /lieferanten
 *   ?tab=locations|location|standorte|raeume    → /locations
 *   sonst (?tab=kunden|kunde oder ohne Tab)     → /kunden
 * Uebrige Query-Parameter werden mitgenommen.
 */

import { redirect } from "next/navigation";

const LIEFERANTEN_TABS = new Set(["lieferanten", "lieferant"]);
const LOCATIONS_TABS = new Set(["locations", "location", "standorte", "raeume"]);

export default async function DatenbankRedirect({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawTab = sp.tab;
  const tab = Array.isArray(rawTab) ? rawTab[0] : rawTab;

  const rest = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "tab" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) rest.append(key, v);
  }

  const ziel = tab && LIEFERANTEN_TABS.has(tab)
    ? "/lieferanten"
    : tab && LOCATIONS_TABS.has(tab)
      ? "/locations"
      : "/kunden";
  const qs = rest.toString();
  redirect(qs ? `${ziel}?${qs}` : ziel);
}
