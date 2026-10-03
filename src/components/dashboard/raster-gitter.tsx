// Das Raster (raster.ts) als Layout — gezeichnet fuer den Inhalt UND das
// Skelett, damit beide Pixel fuer Pixel gleich stehen:
//   - Mit einem Paar irgendwo: volle Breite (max. 1180 px); ab 840 px
//     Inhaltsbreite zwei Spalten (58/42), darunter eine Spalte in
//     Dokument-Reihenfolge (Container-Query auf das @container der Seite).
//     Ein Platz ohne Nachbar nimmt beide Spalten.
//   - Ohne jedes Paar (Einspalten-Modus): eine zentrierte Spalte, max. 720 px.
// Karten einer Reihe sind gleich hoch (Grid-Standard align-items: stretch);
// ihr Inhalt fuellt den Platz (Ruhe-Flaechen und Listen wachsen, Fusszeilen
// stehen unten). Gestapelte Karten eines Platzes stehen mit demselben
// Abstand wie die Reihen untereinander und teilen sich eine Mehrhoehe.
// Keine Hooks — laeuft im Skelett (loading.tsx) wie in der Seite.

import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { hatPaar, type RasterKey, type RasterPlatz } from "@/components/dashboard/raster";

/** Breite der Seite (Kopf + Raster): mit Paar die volle Breite, sonst die
 *  schmale Spalte. Ohne jeden Platz ebenfalls schmal (ein Hinweis). */
export function rasterBreite(reihen: readonly (readonly unknown[])[]): string {
  return hatPaar(reihen) ? "max-w-[1180px]" : "max-w-[720px]";
}

export function RasterGitter<T>({
  reihen,
  karte,
}: {
  reihen: RasterPlatz<T>[][];
  /** Zeichnet einen Bereich des Rasters (Karte bzw. Skelett-Karte). */
  karte: (inhalt: T, key: RasterKey) => ReactNode;
}) {
  const paar = hatPaar(reihen);
  return (
    <div className={cn("grid grid-cols-1 gap-5", paar && "@min-[840px]:grid-cols-[minmax(0,58fr)_minmax(0,42fr)]")}>
      {reihen.flatMap((r) =>
        r.map((p) => (
          // grid: die Karte(n) strecken sich auf die Hoehe der Reihe.
          <div key={p.key} className={cn("grid min-w-0 gap-5", paar && r.length === 1 && "@min-[840px]:col-span-2")}>
            {p.karten.map((k) => (
              <Fragment key={k.key}>{karte(k.inhalt, k.key)}</Fragment>
            ))}
          </div>
        )),
      )}
    </div>
  );
}
