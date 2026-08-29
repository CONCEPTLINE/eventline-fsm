"use client";

/**
 * YearChart — Umsatz/Stunden-Grafik fuer /abrechnung.
 *
 * Analytics-Area-Chart im Vercel/Linear-Stil:
 * - Smooth monotone-cubic Area-Chart (nicht Balken) fuer klare Trend-
 *   Visualisierung ueber 12 Monate.
 * - Aktuelles Jahr: gefuellte teal Area + 2px Line + Punkte an Monaten.
 * - Vorjahr: 1.5px gestrichelte teal/40 Line drueber (Vergleich).
 * - Echte Y-Achse links mit 5 Ticks, dezente horizontale Gridlines.
 * - Hover: vertikaler Crosshair + fokussierter Punkt + Tooltip-Bubble.
 * - Header-KPI mit Total, YoY-Delta, Peak; Jahres-Nav rechts.
 * - Q-Summen kompakt darunter.
 */

import { useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";

const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export interface YearMonthCell {
  month: number;
  hours: number;
  invoices: number;
}
export interface YearData {
  year: number;
  months: YearMonthCell[];
  totalHours: number;
}

export function YearChart({ years }: { years: Map<number, YearData> }) {
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const availableYears = Array.from(years.keys()).sort((a, b) => a - b);
  const minYear = availableYears[0] ?? selectedYear;
  const maxYear = availableYears[availableYears.length - 1] ?? selectedYear;
  const current = years.get(selectedYear);
  const previous = years.get(selectedYear - 1);
  const currentMonth = selectedYear === now.getFullYear() ? now.getMonth() : -1;

  if (!current) return null;

  const maxH = Math.max(
    ...current.months.map((m) => m.hours),
    ...(previous?.months.map((m) => m.hours) ?? [0]),
    1,
  );
  const peakH = Math.max(...current.months.map((m) => m.hours), 0);

  const q = [0, 1, 2, 3].map((qi) => {
    const from = qi * 3, to = from + 3;
    const cur = current.months.slice(from, to).reduce((s, c) => s + c.hours, 0);
    const prev = previous?.months.slice(from, to).reduce((s, c) => s + c.hours, 0) ?? 0;
    return { label: `Q${qi + 1}`, cur, prev };
  });

  const yoy = previous && previous.totalHours > 0
    ? ((current.totalHours - previous.totalHours) / previous.totalHours) * 100
    : null;

  // SVG-Geometrie: Y-Achse links (fuer Skala), rechts randlos.
  // Area-Path spannt alle 12 Punkte auf.
  const W = 800, H = 260;
  const PAD_L = 36, PAD_R = 8, PAD_T = 12, PAD_B = 28;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const yTop = niceCeil(maxH);
  const yTicks = [0, yTop / 4, yTop / 2, (yTop / 4) * 3, yTop];
  // X-Punkte: mittig in jedem Monats-Slot
  const slotW = plotW / 12;
  const pts = current.months.map((cell, i) => ({
    x: PAD_L + i * slotW + slotW / 2,
    y: PAD_T + plotH - (cell.hours / yTop) * plotH,
    hours: cell.hours,
    invoices: cell.invoices,
  }));
  const prevPts = previous
    ? previous.months.map((cell, i) => ({
        x: PAD_L + i * slotW + slotW / 2,
        y: PAD_T + plotH - (cell.hours / yTop) * plotH,
        hours: cell.hours,
      }))
    : null;

  const areaPath = buildSmoothArea(pts, PAD_T + plotH);
  const linePath = buildSmoothLine(pts);
  const prevLinePath = prevPts ? buildSmoothLine(prevPts) : null;

  return (
    <Card className="bg-card">
      <CardContent className="p-5">
        {/* Header: KPI + Nav */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Abgerechnete Stunden
            </p>
            <div className="flex items-baseline gap-3 mt-1 flex-wrap">
              <span className="text-2xl font-bold tabular-nums leading-none">
                {Math.round(current.totalHours)}
                <span className="text-base font-medium text-muted-foreground ml-1">h</span>
              </span>
              {yoy !== null && (
                <span className={`text-sm font-medium tabular-nums ${
                  yoy > 5 ? "text-green-600 dark:text-green-400"
                    : yoy < -5 ? "text-red-600 dark:text-red-400"
                    : "text-muted-foreground"
                }`}>
                  {yoy > 0 ? "+" : ""}{Math.round(yoy)}% <span className="font-normal text-muted-foreground">vs. Vorjahr</span>
                </span>
              )}
              {peakH > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  Peak {Math.round(peakH)}h
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setSelectedYear((y) => Math.max(minYear, y - 1))}
              disabled={selectedYear <= minYear}
              className="p-1.5 rounded-md hover:bg-foreground/[0.06] disabled:opacity-30 transition-colors"
              aria-label="Voriges Jahr"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold tabular-nums w-14 text-center">{selectedYear}</span>
            <button
              type="button"
              onClick={() => setSelectedYear((y) => Math.min(maxYear, y + 1))}
              disabled={selectedYear >= maxYear}
              className="p-1.5 rounded-md hover:bg-foreground/[0.06] disabled:opacity-30 transition-colors"
              aria-label="Nächstes Jahr"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Legende — nur wenn Vorjahr Daten hat */}
        {previous && previous.totalHours > 0 && (
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground mb-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded-sm bg-teal-500" /> {selectedYear}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded-sm bg-teal-500/40" style={{ borderTop: "1.5px dashed" }} /> {selectedYear - 1}
            </span>
          </div>
        )}

        {/* Chart */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full block cursor-crosshair"
          style={{ height: 260 }}
          role="img"
          aria-label={`Abgerechnete Stunden pro Monat ${selectedYear}`}
          onMouseMove={(e) => {
            const svg = svgRef.current;
            if (!svg) return;
            const rect = svg.getBoundingClientRect();
            const vx = ((e.clientX - rect.left) / rect.width) * W;
            const relX = vx - PAD_L;
            if (relX < 0 || relX > plotW) { setHoverIdx(null); return; }
            const idx = Math.min(11, Math.max(0, Math.floor(relX / slotW)));
            setHoverIdx(idx);
          }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="year-chart-area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(20 184 166)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="rgb(20 184 166)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Grid-Linien + Y-Ticks */}
          {yTicks.map((t, i) => {
            const y = PAD_T + plotH - (t / yTop) * plotH;
            return (
              <g key={i}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={W - PAD_R}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth={1}
                  className={i === 0 ? "text-foreground/[0.14]" : "text-foreground/[0.06]"}
                />
                <text
                  x={PAD_L - 6}
                  y={y}
                  fontSize={10}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-current text-muted-foreground/60 tabular-nums"
                >
                  {Math.round(t)}
                </text>
              </g>
            );
          })}

          {/* Quartals-Ticks unten */}
          {[3, 6, 9].map((qi) => {
            const x = PAD_L + qi * slotW;
            return (
              <line key={qi} x1={x} y1={PAD_T + plotH} x2={x} y2={PAD_T + plotH + 5} stroke="currentColor" strokeWidth={1} className="text-foreground/[0.2]" />
            );
          })}

          {/* Area — aktuelles Jahr */}
          <path d={areaPath} fill="url(#year-chart-area-fill)" />

          {/* Line — Vorjahr (gestrichelt, hinter der aktuellen Line) */}
          {prevLinePath && previous && previous.totalHours > 0 && (
            <path
              d={prevLinePath}
              fill="none"
              stroke="rgb(20 184 166)"
              strokeOpacity={0.45}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Line — aktuelles Jahr */}
          <path
            d={linePath}
            fill="none"
            stroke="rgb(20 184 166)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Punkte an jedem Monat (nur wo Werte) */}
          {pts.map((p, i) => (
            p.hours > 0 ? (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={3}
                className="fill-teal-500"
                style={{ pointerEvents: "none" }}
              />
            ) : null
          ))}

          {/* Aktueller-Monat-Marker */}
          {currentMonth >= 0 && pts[currentMonth]?.hours > 0 && (
            <circle
              cx={pts[currentMonth].x}
              cy={pts[currentMonth].y}
              r={5}
              fill="none"
              className="stroke-teal-400"
              strokeWidth={2}
              style={{ pointerEvents: "none" }}
            />
          )}

          {/* Hover: Crosshair + fokussierter Punkt */}
          {hoverIdx !== null && pts[hoverIdx] && (
            <g style={{ pointerEvents: "none" }}>
              <line
                x1={pts[hoverIdx].x}
                y1={PAD_T}
                x2={pts[hoverIdx].x}
                y2={PAD_T + plotH}
                stroke="currentColor"
                strokeWidth={1}
                className="text-foreground/25"
                strokeDasharray="3 3"
              />
              {pts[hoverIdx].hours > 0 && (
                <>
                  <circle
                    cx={pts[hoverIdx].x}
                    cy={pts[hoverIdx].y}
                    r={5}
                    className="fill-teal-500"
                  />
                  <circle
                    cx={pts[hoverIdx].x}
                    cy={pts[hoverIdx].y}
                    r={9}
                    fill="none"
                    className="stroke-teal-500/40"
                    strokeWidth={1.5}
                  />
                </>
              )}
            </g>
          )}

          {/* X-Achse Monats-Labels */}
          {pts.map((p, i) => {
            const isHover = hoverIdx === i;
            const isCurrent = i === currentMonth;
            return (
              <text
                key={i}
                x={p.x}
                y={H - PAD_B + 16}
                fontSize={11}
                textAnchor="middle"
                className={`fill-current tabular-nums ${
                  isCurrent ? "text-foreground font-semibold" : isHover ? "text-foreground" : "text-muted-foreground/70"
                }`}
                style={{ transition: "fill 150ms ease", pointerEvents: "none" }}
              >
                {MONTH_LABELS[i]}
              </text>
            );
          })}

          {/* Tooltip-Bubble */}
          {hoverIdx !== null && pts[hoverIdx].hours > 0 && (
            <HoverBubble
              cx={pts[hoverIdx].x}
              y={pts[hoverIdx].y}
              label={`${MONTH_LABELS[hoverIdx]} ${selectedYear}`}
              hours={pts[hoverIdx].hours}
              invoices={pts[hoverIdx].invoices}
              prevHours={previous?.months[hoverIdx].hours ?? 0}
              W={W}
              H={H}
            />
          )}
        </svg>

        {/* Q-Zeile — richtet sich an der Plot-Area aus (mit gleichem Padding-Verhaeltnis wie SVG) */}
        <div
          className="mt-3 pt-3 border-t border-border/60 grid grid-cols-4"
          style={{
            marginLeft: `${(PAD_L / W) * 100}%`,
            marginRight: `${(PAD_R / W) * 100}%`,
          }}
        >
          {q.map((qi, idx) => {
            const delta = qi.prev > 0 ? ((qi.cur - qi.prev) / qi.prev) * 100 : null;
            const inQ = hoverIdx !== null && Math.floor(hoverIdx / 3) === idx;
            return (
              <div
                key={idx}
                className={`px-2 text-center transition-colors ${idx > 0 ? "border-l border-border/60" : ""}`}
              >
                <div className={`text-[10px] uppercase tracking-wider font-medium transition-colors ${
                  inQ ? "text-teal-600 dark:text-teal-400" : "text-muted-foreground"
                }`}>{qi.label}</div>
                <div className="mt-0.5 text-sm font-semibold tabular-nums">
                  {Math.round(qi.cur)}<span className="text-[10px] text-muted-foreground ml-0.5">h</span>
                </div>
                {previous && previous.totalHours > 0 && delta !== null && (
                  <div className={`text-[10px] tabular-nums mt-0.5 ${
                    delta > 5 ? "text-green-600 dark:text-green-400"
                      : delta < -5 ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground/60"
                  }`}>
                    {delta > 0 ? "+" : ""}{Math.round(delta)}%
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/** Monotone-cubic-Bezier-Interpolation fuer smoothe Line ohne Overshoot.
 *  Klassischer Algorithmus (Fritsch-Carlson tangents), robust bei Nullen. */
type Pt = { x: number; y: number };
function buildSmoothLine(pts: Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  const n = pts.length;
  // Tangenten (Fritsch-Carlson)
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    dy.push(pts[i + 1].y - pts[i].y);
    m.push(dy[i] / dx[i]);
  }
  const t: number[] = new Array(n).fill(0);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t[i] = 0;
    else t[i] = (m[i - 1] + m[i]) / 2;
  }
  // Monotonie erzwingen
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i];
      t[i + 1] = tau * b * m[i];
    }
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    const cp1x = pts[i].x + h / 3;
    const cp1y = pts[i].y + (t[i] * h) / 3;
    const cp2x = pts[i + 1].x - h / 3;
    const cp2y = pts[i + 1].y - (t[i + 1] * h) / 3;
    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${pts[i + 1].x} ${pts[i + 1].y}`;
  }
  return d;
}
function buildSmoothArea(pts: Pt[], baseline: number): string {
  const line = buildSmoothLine(pts);
  if (!line || pts.length === 0) return "";
  const last = pts[pts.length - 1];
  const first = pts[0];
  return `${line} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`;
}

function HoverBubble({
  cx, y, label, hours, invoices, prevHours, W, H,
}: {
  cx: number; y: number; label: string; hours: number; invoices: number; prevHours: number; W: number; H: number;
}) {
  const lines = [
    label,
    `${Math.round(hours)}h · ${invoices} Rechnung${invoices === 1 ? "" : "en"}`,
    ...(prevHours > 0 ? [`Vorjahr: ${Math.round(prevHours)}h`] : []),
  ];
  const w = 160, lh = 15, padY = 9;
  const h = padY * 2 + lines.length * lh;
  const flipLeft = cx + w + 14 > W;
  const bx = flipLeft ? cx - w - 12 : cx + 12;
  const by = Math.max(4, Math.min(y - h / 2, H - h - 4));
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect x={bx} y={by} width={w} height={h} rx={7} className="fill-foreground" opacity={0.96} />
      {lines.map((line, i) => (
        <text
          key={i}
          x={bx + 11}
          y={by + padY + (i + 1) * lh - 4}
          fontSize={11.5}
          className="fill-background"
          style={{ fontWeight: i === 0 ? 600 : 400 }}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function niceCeil(v: number): number {
  if (v <= 10) return 10;
  if (v <= 25) return 25;
  if (v <= 50) return 50;
  if (v <= 100) return 100;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}
