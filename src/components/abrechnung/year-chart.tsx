"use client";

/**
 * YearChart — Umsatz/Stunden-Grafik fuer /abrechnung.
 *
 * Design nach Stripe/Linear-Analytics-Vorbild:
 * - Grosszuegiges Layout mit klarem Header-KPI (Total + YoY)
 * - Jahres-Navigation kompakt oben rechts
 * - Bar-Chart mit dezenten Gridlines, Y-Ticks rechts platziert
 * - Sequenzielles Teal (aktuelles Jahr), 20% Overlay (Vorjahr)
 * - Aktueller Monat: kleiner Marker-Punkt oben, nicht Farbwechsel
 * - Q-Summen als flache Text-Zeile mit Trennstrichen (nicht dominante Boxen)
 * - Hover: schwebende SVG-Tooltip-Bubble nahe der Bar
 */

import { useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";

const MONTH_LABELS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export interface YearMonthCell {
  month: number;   // 1-12
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

  const q = [0, 1, 2, 3].map((qi) => {
    const from = qi * 3, to = from + 3;
    const cur = current.months.slice(from, to).reduce((s, c) => s + c.hours, 0);
    const prev = previous?.months.slice(from, to).reduce((s, c) => s + c.hours, 0) ?? 0;
    return { label: `Q${qi + 1}`, cur, prev };
  });

  const yoy = previous && previous.totalHours > 0
    ? ((current.totalHours - previous.totalHours) / previous.totalHours) * 100
    : null;

  // Grosszuegige SVG-Geometrie — mehr Hoehe fuer prof. Wirkung, breitere Bars
  const W = 800, H = 280;
  const PAD_L = 20, PAD_R = 44, PAD_T = 20, PAD_B = 32;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slotW = plotW / 12;
  const barW = Math.min(slotW * 0.56, 32);
  const bwPrev = barW * 0.42;
  const yTop = niceCeil(maxH);
  const yTicks = [0, yTop / 4, yTop / 2, (yTop / 4) * 3, yTop];

  return (
    <Card className="bg-card">
      <CardContent className="p-5">
        {/* Header: KPI-Zeile — Titel + Total-Zahl + YoY-Delta links, Nav rechts */}
        <div className="flex items-start justify-between gap-4 mb-5">
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

        {/* Legende — dezent, nur wenn Vorjahr Daten hat */}
        {previous && previous.totalHours > 0 && (
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground mb-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-teal-500" /> {selectedYear}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-teal-500/20" /> {selectedYear - 1}
            </span>
          </div>
        )}

        {/* SVG-Chart — grosszuegig, professionelle Anmutung */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto block"
          style={{ maxHeight: 320 }}
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
          {/* Grid-Linien (dezent) + Y-Ticks RECHTS platziert */}
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
                  className={i === 0 ? "text-foreground/[0.12]" : "text-foreground/[0.05]"}
                />
                <text
                  x={W - PAD_R + 6}
                  y={y}
                  fontSize={10}
                  textAnchor="start"
                  dominantBaseline="middle"
                  className="fill-current text-muted-foreground/60 tabular-nums"
                >
                  {Math.round(t)}
                </text>
              </g>
            );
          })}

          {/* Quartals-Trenner: NUR am unteren Rand als kleine Ticks (dezenter als vertikale Linien durchgehend) */}
          {[3, 6, 9].map((qi) => {
            const x = PAD_L + qi * slotW;
            return (
              <line
                key={qi}
                x1={x}
                y1={PAD_T + plotH}
                x2={x}
                y2={PAD_T + plotH + 6}
                stroke="currentColor"
                strokeWidth={1}
                className="text-foreground/[0.15]"
              />
            );
          })}

          {/* Hover-Highlight: dünner vertikaler Fokus-Streifen hinter dem aktiven Slot */}
          {hoverIdx !== null && (
            <rect
              x={PAD_L + hoverIdx * slotW + slotW / 2 - 0.5}
              y={PAD_T}
              width={1}
              height={plotH}
              className="fill-foreground/20"
              style={{ pointerEvents: "none" }}
            />
          )}

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
                {/* Vorjahr — heller Overlay */}
                {prevCell && prevCell.hours > 0 && (
                  <rect
                    x={prevX}
                    y={PAD_T + plotH - prevH}
                    width={bwPrev}
                    height={prevH}
                    rx={2}
                    className="fill-teal-500/20"
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
                    style={{ transition: "opacity 180ms ease" }}
                    opacity={hoverIdx !== null && !isHover ? 0.35 : 1}
                  />
                )}
                {/* Aktueller-Monat-Marker: kleiner Punkt ganz oben statt Farbwechsel */}
                {isCurrentMonth && cell.hours > 0 && (
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
                  fontSize={10}
                  textAnchor="middle"
                  className={`fill-current tabular-nums ${
                    isCurrentMonth
                      ? "text-foreground font-semibold"
                      : isHover
                        ? "text-foreground"
                        : "text-muted-foreground/70"
                  }`}
                  style={{ transition: "fill 180ms ease" }}
                >
                  {MONTH_LABELS[i]}
                </text>
              </g>
            );
          })}

          {/* Schwebende Tooltip-Bubble */}
          {hoverIdx !== null && current.months[hoverIdx].hours > 0 && (
            <HoverBubble
              cx={PAD_L + hoverIdx * slotW + slotW / 2}
              y={PAD_T + plotH - (current.months[hoverIdx].hours / yTop) * plotH}
              label={`${MONTH_LABELS[hoverIdx]} ${selectedYear}`}
              hours={current.months[hoverIdx].hours}
              invoices={current.months[hoverIdx].invoices}
              prevHours={previous?.months[hoverIdx].hours ?? 0}
              W={W}
            />
          )}
        </svg>

        {/* Q-Zeile: flach, mit dünnen Trennstrichen zwischen Q1..Q4.
            Aligned mit der Chart-Bar-Area via padding-Verhältnis. */}
        <div
          className="mt-4 pt-3 border-t border-border/60 grid grid-cols-4"
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
                className={`px-2 text-center transition-colors ${
                  idx > 0 ? "border-l border-border/60" : ""
                } ${inQ ? "opacity-100" : "opacity-90"}`}
              >
                <div className={`text-[10px] uppercase tracking-wider font-medium ${
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

/** SVG-Tooltip-Bubble die schwebt nahe der Bar. Automatisches Flipping wenn
 *  am rechten Rand (positioniert sich links vom Punkt statt rechts). */
function HoverBubble({
  cx, y, label, hours, invoices, prevHours, W,
}: {
  cx: number; y: number; label: string; hours: number; invoices: number; prevHours: number; W: number;
}) {
  const lines = [
    `${label}`,
    `${Math.round(hours)}h · ${invoices} Rechnung${invoices === 1 ? "" : "en"}`,
    ...(prevHours > 0 ? [`Vorjahr: ${Math.round(prevHours)}h`] : []),
  ];
  const w = 150, lh = 14, padY = 8;
  const h = padY * 2 + lines.length * lh;
  // Flip nach links wenn zu nah am rechten Rand
  const flipLeft = cx + w + 12 > W;
  const bx = flipLeft ? cx - w - 8 : cx + 8;
  const by = Math.max(4, y - h / 2);
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect
        x={bx}
        y={by}
        width={w}
        height={h}
        rx={6}
        className="fill-foreground"
        opacity={0.95}
      />
      {lines.map((line, i) => (
        <text
          key={i}
          x={bx + 10}
          y={by + padY + (i + 1) * lh - 4}
          fontSize={11}
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
