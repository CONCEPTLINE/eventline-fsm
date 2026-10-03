// Das feste Raster des Dashboards — EINE Definition fuer den Inhalt
// (dashboard-inhalt.tsx) und das Skelett (dashboard-skelett.tsx), beide
// gezeichnet von RasterGitter (raster-gitter.tsx), damit das Skelett genau
// die Plaetze zeigt, die gleich mit Daten gefuellt werden.
//
// Drei Reihen zu je [links | rechts] (links 58 %, rechts 42 %):
//   [Braucht Aufmerksamkeit | Meine Todos]
//   [Anwesenheit            | Team]
//   [Als Naechstes          | Naechster Einsatz ueber Mein Monat]
// Ein Platz kann mehrere Bereiche untereinander tragen (gestapelt); er ist
// belegt, sobald einer davon sichtbar ist, und zeigt nur die sichtbaren.
// Sind beide Plaetze einer Reihe belegt, stehen sie als Paar nebeneinander;
// ist es nur einer, nimmt er die ganze Reihe; leere Reihen entfallen. Hat
// keine Reihe ein Paar, wird das Dashboard eine schmale Spalte
// (Einspalten-Modus, z. B. Techniker: Todos, Einsatz, Monat untereinander).
// Die Kennzahlen stehen im Kopf und haben hier keinen Platz.

import type { DashboardBereichKey } from "@/lib/dashboard-bereiche";

export const RASTER = [
  [["aufmerksamkeit"], ["todos"]],
  [["anwesenheit"], ["team"]],
  [["naechste"], ["einsatz", "monat"]],
] as const satisfies readonly (readonly [readonly DashboardBereichKey[], readonly DashboardBereichKey[]])[];

/** Bereiche mit einem Platz im Raster (alle ausser den Kennzahlen). */
export type RasterKey = (typeof RASTER)[number][number][number];

/** Alle Bereiche des Rasters in Dokument-Reihenfolge (so stehen sie auch
 *  in der einen Spalte schmaler Bildschirme). */
export const RASTER_KEYS: readonly RasterKey[] = RASTER.flatMap((reihe) => reihe.flatMap((platz) => [...platz]));

export interface RasterPlatz<T> {
  /** Erster Bereich des Platzes laut Raster — stabiler React-Key. */
  key: RasterKey;
  /** Die sichtbaren Bereiche des Platzes, von oben nach unten. */
  karten: { key: RasterKey; inhalt: T }[];
}

/** Belegte Reihen in Raster-Reihenfolge: je Reihe die belegten Plaetze
 *  (einer oder zwei), je Platz seine sichtbaren Bereiche; Reihen ohne
 *  belegten Platz entfallen. */
export function belegteReihen<T>(karten: ReadonlyMap<RasterKey, T>): RasterPlatz<T>[][] {
  const reihen: RasterPlatz<T>[][] = [];
  for (const reihe of RASTER) {
    const r: RasterPlatz<T>[] = [];
    for (const platz of reihe) {
      const keys: readonly RasterKey[] = platz;
      const belegt = keys.filter((k) => karten.has(k)).map((k) => ({ key: k, inhalt: karten.get(k) as T }));
      if (belegt.length > 0) r.push({ key: keys[0], karten: belegt });
    }
    if (r.length > 0) reihen.push(r);
  }
  return reihen;
}

/** Steht irgendwo ein Paar nebeneinander? Sonst Einspalten-Modus. */
export function hatPaar(reihen: readonly (readonly unknown[])[]): boolean {
  return reihen.some((r) => r.length > 1);
}
