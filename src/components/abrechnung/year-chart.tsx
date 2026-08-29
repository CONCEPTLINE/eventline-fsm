"use client";

/**
 * YearChart — Umsatz/Stunden-Grafik fuer /abrechnung.
 *
 * Bar-Chart im Analytics-Stil (Vercel/Linear/Stripe):
 * - 12 Monatsbalken, aktuelles Jahr teal-solid, Vorjahr als schmalerer
 *   heller Overlay dahinter (teal/25).
 * - Y-Achse links mit 5 Ticks, dezente horizontale Gridlines.
 * - Header-KPI: Total + YoY-Delta + Peak; Jahres-Nav rechts.
 * - Hover: aktiver Balken bekommt teal Highlight-Ring + brightness-Boost,
 *   nicht-gehoverte dimmen auf 42%. Tooltip-Bubble mit Auto-Flip.
 * - Aktueller Monat: Marker-Punkt oben; Label fett.
 * - Q-Summen kompakt darunter, aligned an Plot-Area.
 *
 * KEIN preserveAspectRatio="none" — SVG behaelt Verhaeltnisse
 * (sonst wuerden Punkte zu Ellipsen und Kurven wirken verzerrt).
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

  // SVG-Geometrie: Y-Achse links, kein preserveAspectRatio-Trick.
  // Aspect-Ratio des SVG (800:260 = ~3.1:1) bestimmt die tatsaechliche
  // Render-Groesse. Card kann darum breiter sein — SVG zentriert dann.
  const W = 800, H = 170;
  const PAD_L = 32, PAD_R = 8, PAD_T = 8, PAD_B = 24;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slotW = plotW / 12;
  const barW = Math.min(slotW * 0.54, 26);
  const bwPrev = barW * 0.42;
  const yTop = niceCeil(maxH);
  const yTicks = [0, yTop / 4, yTop / 2, (yTop / 4) * 3, yTop];

  return (
    <Card className="bg-card">
      <CardContent className="p-3">
        {/* Header: eine Zeile — Titel + KPI links, Legende + Nav rechts */}
        <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
          <div className="flex items-baseline gap-2 flex-wrap min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Abgerechnete Stunden
            </p>
            <span className="text-lg font-bold tabular-nums leading-none">
              {Math.round(current.totalHours)}<span className="text-xs font-medium text-muted-foreground ml-0.5">h</span>
            </span>
            {yoy !== null && (
              <span className={`text-[11px] font-medium tabular-nums ${
                yoy > 5 ? "text-green-600 dark:text-green-400"
                  : yoy < -5 ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground"
              }`}>
                {yoy > 0 ? "+" : ""}{Math.round(yoy)}% VJ
              </span>
            )}
            {peakH > 0 && (
              <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                · Peak {Math.round(peakH)}h
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {previous && previous.totalHours > 0 && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-teal-500" /> {selectedYear}</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-teal-500/25" /> {selectedYear - 1}</span>
              </div>
            )}
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setSelectedYear((y) => Math.max(minYear, y - 1))}
                disabled={selectedYear <= minYear}
                className="p-1 rounded hover:bg-foreground/[0.06] disabled:opacity-30 transition-colors"
                aria-label="Voriges Jahr"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs font-semibold tabular-nums w-12 text-center">{selectedYear}</span>
              <button
                type="button"
                onClick={() => setSelectedYear((y) => Math.min(maxYear, y + 1))}
                disabled={selectedYear >= maxYear}
                className="p-1 rounded hover:bg-foreground/[0.06] disabled:opacity-30 transition-colors"
                aria-label="Nächstes Jahr"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Chart */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto block cursor-crosshair"
          role="img"
          aria-label={`Abgerechnete Stunden pro Monat ${selectedYear}`}
          onMouseMove={(e) => {
            const svg = svgRef.current;
            if (!svg) return;
            const rect = svg.getBoundingClientRect();
            // svg mit erhaltenem Aspect-Ratio: der Rect matched die
            // tatsaechlich gerenderte Groesse. Scale = rect.width / W.
            const scale = rect.width / W;
            const vx = (e.clientX - rect.left) / scale;
            const relX = vx - PAD_L;
            if (relX < 0 || relX > plotW) { setHoverIdx(null); return; }
            const idx = Math.min(11, Math.max(0, Math.floor(relX / slotW)));
            setHoverIdx(idx);
          }}
          onMouseLeave={() => setHoverIdx(null)}
        >
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

          {/* Quartals-Ticks */}
          {[3, 6, 9].map((qi) => {
            const x = PAD_L + qi * slotW;
            return (
              <line
                key={qi}
                x1={x}
                y1={PAD_T + plotH}
                x2={x}
                y2={PAD_T + plotH + 5}
                stroke="currentColor"
                strokeWidth={1}
                className="text-foreground/[0.2]"
              />
            );
          })}

          {/* Balken */}
          {current.months.map((cell, i) => {
            const prevCell = previous?.months[i];
            const cx = PAD_L + i * slotW + slotW / 2;
            const barX = cx - barW / 2;
            const prevX = cx - bwPrev / 2;
            const cellH = (cell.hours / yTop) * plotH;
            const prevH = ((prevCell?.hours ?? 0) / yTop) * plotH;
            const isHover = hoverIdx === i;
            const isCurrentMonth = i === currentMonth;
            return (
              <g key={i} style={{ pointerEvents: "none" }}>
                {/* Vorjahr — heller Overlay hinter aktuellem Balken */}
                {prevCell && prevCell.hours > 0 && (
                  <rect
                    x={prevX}
                    y={PAD_T + plotH - prevH}
                    width={bwPrev}
                    height={prevH}
                    rx={2}
                    className="fill-teal-500/25"
                  />
                )}
                {/* Aktueller Balken */}
                {cell.hours > 0 && (
                  <rect
                    x={barX}
                    y={PAD_T + plotH - cellH}
                    width={barW}
                    height={cellH}
                    rx={3}
                    className="fill-teal-500"
                    style={{
                      transition: "filter 150ms ease, opacity 150ms ease",
                      filter: isHover ? "brightness(1.15)" : undefined,
                      opacity: hoverIdx !== null && !isHover ? 0.42 : 1,
                    }}
                  />
                )}
                {/* Hover-Ring */}
                {isHover && cell.hours > 0 && (
                  <rect
                    x={barX - 1.5}
                    y={PAD_T + plotH - cellH - 1.5}
                    width={barW + 3}
                    height={cellH + 3}
                    rx={4}
                    fill="none"
                    className="stroke-teal-300 dark:stroke-teal-400"
                    strokeWidth={1.5}
                  />
                )}
                {/* Aktueller-Monat-Marker */}
                {isCurrentMonth && cell.hours > 0 && !isHover && (
                  <circle
                    cx={cx}
                    cy={PAD_T + plotH - cellH - 6}
                    r={2}
                    className="fill-teal-400"
                  />
                )}
                {/* Monats-Label */}
                <text
                  x={cx}
                  y={H - PAD_B + 16}
                  fontSize={11}
                  textAnchor="middle"
                  className={`fill-current tabular-nums ${
                    isCurrentMonth ? "text-foreground font-semibold" : isHover ? "text-foreground" : "text-muted-foreground/70"
                  }`}
                  style={{ transition: "fill 150ms ease" }}
                >
                  {MONTH_LABELS[i]}
                </text>
              </g>
            );
          })}

          {/* Tooltip-Bubble */}
          {hoverIdx !== null && current.months[hoverIdx].hours > 0 && (
            <HoverBubble
              cx={PAD_L + hoverIdx * slotW + slotW / 2}
              y={PAD_T + plotH - (current.months[hoverIdx].hours / yTop) * plotH}
              label={`${MONTH_LABELS[hoverIdx]} ${selectedYear}`}
              hours={current.months[hoverIdx].hours}
              invoices={current.months[hoverIdx].invoices}
              prevHours={previous?.months[hoverIdx].hours ?? 0}
              W={W}
              H={H}
            />
          )}
        </svg>

        {/* Q-Zeile — kompakt in EINER Zeile, aligned an Plot-Area */}
        <div
          className="mt-2 pt-2 border-t border-border/60 grid grid-cols-4"
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
                className={`px-2 flex items-baseline justify-center gap-1.5 ${idx > 0 ? "border-l border-border/60" : ""}`}
              >
                <span className={`text-[10px] uppercase tracking-wider font-medium transition-colors ${
                  inQ ? "text-teal-600 dark:text-teal-400" : "text-muted-foreground"
                }`}>{qi.label}</span>
                <span className="text-xs font-semibold tabular-nums">
                  {Math.round(qi.cur)}<span className="text-[9px] text-muted-foreground/70">h</span>
                </span>
                {previous && previous.totalHours > 0 && delta !== null && (
                  <span className={`text-[9px] tabular-nums ${
                    delta > 5 ? "text-green-600 dark:text-green-400"
                      : delta < -5 ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground/60"
                  }`}>
                    {delta > 0 ? "+" : ""}{Math.round(delta)}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
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
