"use client";

/**
 * Ziehbarer Griff zwischen zwei Spalten.
 *
 * Breiten sind Arbeitsgewohnheit, keine Designentscheidung: wer viel in
 * der Liste liest, will sie breit; wer die Karte nutzt, will sie gross.
 * Deshalb verstellbar — und gemerkt, sonst müsste man es nach jedem
 * Reload neu einstellen (§10).
 *
 * Bewegt wird über `document`-Listener, nicht über die Maus auf dem
 * Griff: sonst reisst das Ziehen ab, sobald der Zeiger beim schnellen
 * Bewegen den schmalen Griff verlässt.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function SpaltenGriff({
  breite, onBreite, min = 240, max = 760, invertiert = false,
}: {
  breite: number;
  onBreite: (px: number) => void;
  min?: number;
  max?: number;
  /** true, wenn die Spalte rechts vom Griff liegt (Detailspalte). */
  invertiert?: boolean;
}) {
  const [zieht, setZieht] = useState(false);
  const start = useRef({ x: 0, breite: 0 });

  const bewegen = useCallback((e: PointerEvent) => {
    const delta = e.clientX - start.current.x;
    const neu = start.current.breite + (invertiert ? -delta : delta);
    onBreite(Math.round(Math.min(max, Math.max(min, neu))));
  }, [onBreite, min, max, invertiert]);

  const loslassen = useCallback(() => setZieht(false), []);

  useEffect(() => {
    if (!zieht) return;
    document.addEventListener("pointermove", bewegen);
    document.addEventListener("pointerup", loslassen);
    // Während des Ziehens nichts markieren und den Cursor behalten.
    const vorher = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("pointermove", bewegen);
      document.removeEventListener("pointerup", loslassen);
      document.body.style.cursor = vorher;
      document.body.style.userSelect = "";
    };
  }, [zieht, bewegen, loslassen]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Spaltenbreite ändern"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, breite };
        setZieht(true);
      }}
      // Doppelklick setzt zurück — schneller als zurückziehen.
      onDoubleClick={() => onBreite(invertiert ? 448 : 352)}
      className="group relative w-1.5 shrink-0 cursor-col-resize"
    >
      <div
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors"
        style={{ backgroundColor: zieht ? "#e0312f" : "var(--border)" }}
      />
      {/* Breitere, unsichtbare Greiffläche: ein 1px-Strich ist nicht
          zuverlässig zu treffen. */}
      <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-foreground/5" />
    </div>
  );
}
