"use client";

// Client-Komponente, damit das Skelett die Bereichs-Liste der laufenden
// Sitzung lesen kann (Modul-Gedaechtnis in session-cache.ts — auf dem Server
// immer leer, dann das volle Raster).

import { DashboardSkelett } from "@/components/dashboard/dashboard-skelett";
import { gemerkteBereiche } from "@/components/dashboard/session-cache";

/** Navigations-Skelett (CLAUDE.md §7): dasselbe Raster wie die Seite — aus
 *  der zuletzt bekannten Bereichs-Liste, ohne Kenntnis das volle Raster. */
export default function Loading() {
  return <DashboardSkelett bereiche={gemerkteBereiche()} />;
}
