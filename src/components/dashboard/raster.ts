// Das feste Raster des Dashboards — EINE Definition fuer den Inhalt
// (dashboard-inhalt.tsx) und das Skelett (dashboard-skelett.tsx), damit das
// Skelett genau die Plaetze zeigt, die gleich mit Daten gefuellt werden.
//
// Drei Reihen zu je [links | rechts] (links 58 %, rechts 42 %). Fehlt ein
// Nachbar, nimmt der Platz die ganze Reihe; leere Reihen entfallen. Die
// Kennzahlen stehen im Kopf und haben hier keinen Platz.

import type { DashboardBereichKey } from "@/lib/dashboard-bereiche";

export const RASTER = [
  ["aufmerksamkeit", "team"],
  ["anwesenheit", "naechste"],
  ["einsatz", "monat"],
] as const satisfies readonly (readonly [DashboardBereichKey, DashboardBereichKey])[];

/** Bereiche mit einem Platz im Raster (alle ausser den Kennzahlen). */
export type RasterKey = (typeof RASTER)[number][number];

export interface RasterPlatz<T> {
  key: RasterKey;
  inhalt: T;
}

/** Belegte Reihen in Raster-Reihenfolge: je Reihe die vorhandenen Plaetze
 *  (einer oder zwei), Reihen ohne Platz entfallen. */
export function belegteReihen<T>(plaetze: ReadonlyMap<RasterKey, T>): RasterPlatz<T>[][] {
  const reihen: RasterPlatz<T>[][] = [];
  for (const reihe of RASTER) {
    const r: RasterPlatz<T>[] = [];
    for (const key of reihe) {
      if (!plaetze.has(key)) continue;
      r.push({ key, inhalt: plaetze.get(key) as T });
    }
    if (r.length > 0) reihen.push(r);
  }
  return reihen;
}
