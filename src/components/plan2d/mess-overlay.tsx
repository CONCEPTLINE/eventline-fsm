"use client";

// Mess-Overlay fuer den Aufbauplan: Linie zwischen zwei Punkten + Distanz
// in Metern (px_pro_meter aus der Plan-Kalibrierung). Geteilt zwischen
// PlanEditor (Firma) und PlanViewer (Lieferantenportal) — beide Seiten
// messen identisch (Kabellaengen, Abstaende).

const FARBE = "#f53c3a";

export function MessOverlay({
  punkte, ppm, planBreite, zoom = 1,
}: {
  punkte: { x: number; y: number }[];
  ppm: number;
  planBreite: number;
  /** Aktueller View-Zoom (Editor) — kompensiert, damit Linie/Text am
   *  Bildschirm konstant gross bleiben. Viewer: 1. */
  zoom?: number;
}) {
  if (punkte.length === 0) return null;
  // Groessen relativ zur Planbreite (grosse Unterlagen = grosse Pixel).
  const s = Math.max(1, planBreite / 900) / zoom;
  const r = 5 * s;
  const strich = 2.5 * s;
  const schrift = 15 * s;

  const [a, b] = punkte;
  const fertig = punkte.length === 2;
  const meter = fertig ? Math.hypot(b.x - a.x, b.y - a.y) / ppm : 0;
  const mitte = fertig ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;

  return (
    <g pointerEvents="none">
      {fertig && (
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={FARBE} strokeWidth={strich} strokeDasharray={`${4 * s} ${3 * s}`} />
      )}
      {punkte.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={r} fill={FARBE} stroke="#ffffff" strokeWidth={strich / 2} />
      ))}
      {fertig && mitte && (
        <text
          x={mitte.x}
          y={mitte.y - 8 * s}
          textAnchor="middle"
          fontSize={schrift}
          fontWeight={700}
          fill={FARBE}
          stroke="#ffffff"
          strokeWidth={4 * s}
          paintOrder="stroke"
          style={{ userSelect: "none" }}
        >
          {meter.toFixed(meter < 10 ? 2 : 1)} m
        </text>
      )}
    </g>
  );
}
