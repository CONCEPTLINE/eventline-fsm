"use client";

// Client-Komponente, damit das Skelett die Bereichs-Liste der laufenden
// Sitzung lesen kann (Modul-Gedaechtnis in session-cache.ts — auf dem Server
// immer leer, dann das volle Raster).

import { DashboardSkelett } from "@/components/dashboard/dashboard-skelett";
import { gemerkteBereiche } from "@/components/dashboard/session-cache";
import { Skeleton } from "@/components/ui/skeleton";

/** Navigations-Skelett (CLAUDE.md §7). Desktop (ab md): dasselbe Raster wie
 *  die Seite — aus der zuletzt bekannten Bereichs-Liste, ohne Kenntnis das
 *  volle Raster. Handy (< md): Heute-Screen (Datum, Einsatz-Karte 196 px,
 *  drei Zeilen 56 px), passend zu src/components/mobile/heute-screen.tsx. */
export default function Loading() {
  return (
    <>
      <div className="hidden md:block">
        <DashboardSkelett bereiche={gemerkteBereiche()} />
      </div>

      <div className="md:hidden flex flex-col gap-5" aria-busy>
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-[196px] rounded-2xl" />
        <div className="flex flex-col gap-1">
          <Skeleton className="h-3.5 w-28" />
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex h-14 items-center gap-3 border-t border-border px-4 first:border-t-0">
                <Skeleton className="h-6 w-6 rounded-md" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
