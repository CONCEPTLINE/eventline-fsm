"use client";

// Read-only-Raumplan fuer das Lieferantenportal: gleiche visuelle Sprache
// wie der Plan-Editor (Material blau, Objekte violett, Grundriss als
// Unterlage), aber ohne Drag/Palette — der Lieferant schaut und
// kommentiert, EVENTLINE plant.

import { useRef, useState } from "react";
import { Ruler } from "lucide-react";
import { materialForm, materialMasse, type PlanPos } from "@/lib/plan2d";
import { MessOverlay } from "@/components/plan2d/mess-overlay";

const FARBE_MATERIAL = "#2f6fb0";
const FARBE_OBJEKT = "#6b21a8";

export interface ViewerObjekt {
  id: string;
  typ: string;
  label: string | null;
  x: number;
  y: number;
  rot: number;
  breite: number | null;
  tiefe: number | null;
}

export interface ViewerMaterial {
  id: string;
  bezeichnung: string;
  menge: number;
  masse: { l: number | null; b: number | null; h: number | null } | null;
  position: (PlanPos | null)[] | null;
}

export function PlanViewer({
  unterlageUrl, breitePx, hoehePx, ppm, objekte, material,
}: {
  unterlageUrl: string;
  breitePx: number;
  hoehePx: number;
  ppm: number;
  objekte: ViewerObjekt[];
  material: ViewerMaterial[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [messModus, setMessModus] = useState(false);
  const [messPunkte, setMessPunkte] = useState<{ x: number; y: number }[]>([]);

  function messKlick(e: React.MouseEvent) {
    if (!messModus || !svgRef.current) return;
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    setMessPunkte((prev) => (prev.length >= 2 ? [{ x: p.x, y: p.y }] : [...prev, { x: p.x, y: p.y }]));
  }

  return (
    <div className="relative">
    <svg
      ref={svgRef}
      viewBox={`0 0 ${breitePx} ${hoehePx}`}
      className="w-full h-auto rounded-lg border border-border bg-white"
      style={messModus ? { cursor: "crosshair" } : undefined}
      onClick={messKlick}
      role="img"
      aria-label="Raumplan"
    >
      <image href={unterlageUrl} x={0} y={0} width={breitePx} height={hoehePx} />
      {material.flatMap((m) =>
        (m.position ?? []).map((pos, i) => {
          if (!pos) return null;
          const form = materialForm(m.bezeichnung);
          const masse = materialMasse(form, m.masse);
          const w = masse.l * ppm;
          const h = masse.b * ppm;
          return (
            <g key={`${m.id}-${i}`} transform={`translate(${pos.x} ${pos.y}) rotate(${pos.rot})`}>
              {form === "licht" ? (
                <>
                  <circle r={Math.max(w / 2, 5)} fill={FARBE_MATERIAL} fillOpacity={0.75} stroke={FARBE_MATERIAL} strokeWidth={1.5} />
                  <line x1={0} y1={0} x2={0} y2={-Math.max(w, 10)} stroke={FARBE_MATERIAL} strokeWidth={2} />
                </>
              ) : (
                <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={FARBE_MATERIAL} fillOpacity={0.55} stroke={FARBE_MATERIAL} strokeWidth={1.5} rx={2} />
              )}
              <text y={h / 2 + 12} textAnchor="middle" fontSize={11} fill={FARBE_MATERIAL} style={{ userSelect: "none" }}>
                {m.bezeichnung.slice(0, 18)}{m.menge > 1 ? ` ${i + 1}` : ""}
              </text>
            </g>
          );
        }),
      )}
      {objekte.map((o) => {
        const w = (o.breite ?? 0.5) * ppm;
        const h = (o.tiefe ?? 0.5) * ppm;
        return (
          <g key={o.id} transform={`translate(${o.x} ${o.y}) rotate(${o.rot})`}>
            {o.typ === "text" ? (
              <text textAnchor="middle" fontSize={14} fontWeight={600} fill={FARBE_OBJEKT} style={{ userSelect: "none" }}>
                {o.label ?? "Text"}
              </text>
            ) : (
              <>
                <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={FARBE_OBJEKT} fillOpacity={0.45} stroke={FARBE_OBJEKT} strokeWidth={1.5} rx={2} />
                <text textAnchor="middle" dominantBaseline="middle" fontSize={Math.min(12, h * 0.6)} fontWeight={600} fill="#fff" style={{ userSelect: "none" }}>
                  {(o.label ?? o.typ).slice(0, 10)}
                </text>
              </>
            )}
          </g>
        );
      })}
      <MessOverlay punkte={messPunkte} ppm={ppm} planBreite={breitePx} />
    </svg>
    <div className="absolute top-2 right-2 flex items-center gap-1.5">
      {messModus && (
        <span className="text-[11px] bg-card/95 border border-border rounded-lg px-2 py-1 text-muted-foreground">
          {messPunkte.length === 0 ? "Ersten Punkt anklicken" : messPunkte.length === 1 ? "Zweiten Punkt anklicken" : "Neuer Klick = neue Messung"}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setMessModus((m) => {
            if (m) setMessPunkte([]);
            return !m;
          });
        }}
        className={`kasten ${messModus ? "kasten-active" : "kasten-muted"}`}
        data-tooltip="Distanz messen (z.B. Kabellänge) — zwei Punkte anklicken"
        data-tooltip-align="end"
      >
        <Ruler className="h-3.5 w-3.5" />
        Messen
      </button>
    </div>
    </div>
  );
}
