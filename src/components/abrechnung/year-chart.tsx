"use client";

/**
 * YearChart — Umsatz/Stunden-Grafik fuer /abrechnung.
 *
 * Minimalistischer Analytics-Look (Vercel/Linear/Stripe):
 * - Keine Y-Achse, keine Gridlines — Peak-Info steht im Header, Werte kommen
 *   per Hover. Bar-Area nutzt die VOLLE Card-Breite (kein Padding fuer
 *   Achsen-Labels), Q-Zeile fluchtet damit exakt.
 * - Header-KPI: Total + YoY-Delta + Jahres-Nav rechts.
 * - Sequenzielles Teal (aktuelles Jahr), 20% Overlay (Vorjahr).
 * - Aktueller Monat: kleiner Marker-Punkt oben.
 * - Q-Summen als flache Text-Zeile mit Trennstrichen.
 * - Hover: sichtbarer Highlight-Rand um den aktiven Balken +
 *   schwebende Tooltip-Bubble (auto-flip am rechten Rand).
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

  // SVG-Geometrie: Bars nutzen die VOLLE Breite (PAD_L/R = 0), damit
  // der Chart bis an die Card-Raender geht. Vertikale Paddings nur
  // fuer Marker + Monats-Labels.
  const W = 800, H = 260;
  const PAD_L = 0, PAD_R = 0, PAD_T = 24, PAD_B = 32;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slotW = plotW / 12;
  const barW = Math.min(slotW * 0.58, 36);
  const bwPrev = barW * 0.4;
  const yTop = niceCeil(maxH);

  return (
    <Card className="bg-card">
      <CardContent className="p-5">
        {/* Header: KPI-Zeile */}
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
                <span className="text-[11px] text-muted-foreground tabular-nums ml-auto sm:ml-2">
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
              <span className="w-2.5 h-2.5 rounded-sm bg-teal-500" /> {selectedYear}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-teal-500/20" /> {selectedYear - 1}
            </span>
          </div>
        )}

        {/* Chart — full-width, keine Achsen */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full block cursor-crosshair"
          style={{ height: 240 }}
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
          {/* Baseline unten — subtile Trennung */}
          <line
            x1={0}
            y1={PAD_T + plotH}
            x2={W}
            y2={PAD_T + plotH}
            stroke="currentColor"
            strokeWidth={1}
            className="text-foreground/[0.10]"
          />

          {/* Quartals-Trenner: kleine Ticks unter der Baseline */}
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
                className="text-foreground/[0.18]"
              />
            );
          })}

          {/* Balken (aspectRatio: none — Bars behalten ihre relative Breite ueber viewBox-Skalierung) */}
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
                {/* Aktueller Balken — hover: nicht dimmen sondern glow */}
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
                {/* Hover-Ring um den aktiven Balken */}
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
                  y={H - PAD_B + 18}
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

        {/* Q-Zeile — full-width (matched jetzt exakt der Bar-Area, weil PAD_L=PAD_R=0) */}
        <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-4">
          {q.map((qi, idx) => {
            const delta = qi.prev > 0 ? ((qi.cur - qi.prev) / qi.prev) * 100 : null;
            const inQ = hoverIdx !== null && Math.floor(hoverIdx / 3) === idx;
            return (
              <div
                key={idx}
                className={`px-2 text-center transition-colors ${
                  idx > 0 ? "border-l border-border/60" : ""
                }`}
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

function HoverBubble({
  cx, y, label, hours, invoices, prevHours, W,
}: {
  cx: number; y: number; label: string; hours: number; invoices: number; prevHours: number; W: number;
}) {
  const lines = [
    label,
    `${Math.round(hours)}h · ${invoices} Rechnung${invoices === 1 ? "" : "en"}`,
    ...(prevHours > 0 ? [`Vorjahr: ${Math.round(prevHours)}h`] : []),
  ];
  const w = 160, lh = 15, padY = 9;
  const h = padY * 2 + lines.length * lh;
  const flipLeft = cx + w + 14 > W;
  const bx = flipLeft ? cx - w - 10 : cx + 10;
  const by = Math.max(4, Math.min(y - h / 2, 260 - h - 4));
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect
        x={bx}
        y={by}
        width={w}
        height={h}
        rx={7}
        className="fill-foreground"
        opacity={0.96}
      />
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
