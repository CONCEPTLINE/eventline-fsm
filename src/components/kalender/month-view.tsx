"use client";

/**
 * Monatsansicht — Standard-7×6-Grid (immer 6 Wochen damit der Layout-Sprung
 * zwischen Monaten mit unterschiedlicher Zeilenanzahl ausbleibt).
 *
 * Architektur-Wechsel: per-Woche-Grid statt per-Cell-Bars-mit-Negativ-Margin.
 *   - Jede Woche ist ihr eigenes 7-Spalten-Grid
 *   - Cell-Hintergrund/Klick-Button spannt seine Spalte ueber die ganze Hoehe
 *     der Woche (gridRow "1 / -1") — das ist die Klick-Flaeche.
 *   - Multi-Day-Bars sind EIN Element pro Wochen-Segment, das via gridColumn
 *     mehrere Spalten ueberspannt. Kein Cell-Hopping, keine Border-Seams,
 *     keine negativen Margins — der Bar IST eine Box, kein Stack von Boxen.
 *   - Lane-Packing pro Woche: laengster Span zuerst, niedrigste Lane.
 *
 * Konsequenz: An Wochengrenzen bricht der Bar visuell (jedes Wochen-Segment
 * ist eigenes Element). Die zur ausserhalb-Woche zeigende Kante kriegt
 * "openLeft/openRight"-Style — eckig statt rund — damit der User sieht
 * dass es weitergeht. An Bar-Anfang/Ende: rund.
 */

import Link from "next/link";
import { useMemo, Fragment } from "react";
import { MapPin, ExternalLink, Clock, User } from "lucide-react";
import type { CalendarItem, CalendarShift } from "./types";

const MAX_LANES_PER_WEEK = 6;
const LANE_HEIGHT_PX = 22;
const HEADER_HEIGHT_PX = 28;

interface Props {
  year: number;
  month: number;
  items: CalendarItem[];
  shifts: CalendarShift[];
  selectedDay: number | null;
  onSelectDay: (day: number | null) => void;
  /** Klick auf einen Tag des Vor-/Folge-Monats: Parent springt zu diesem
   *  Monat und setzt den geklickten Tag als selected. */
  onNavigate: (date: Date) => void;
  /** Klick auf einen Termin ohne Job-Bezug im Tages-Side-Panel. Optional —
   *  wenn nicht gesetzt bleibt der Termin static (kein Edit-Pfad). */
  onStandaloneShiftClick?: (shiftId: string) => void;
}

interface Cell {
  date: Date;
  inMonth: boolean;
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TYPE_STYLE: Record<CalendarItem["type"], { bg: string; text: string; dot: string; ring: string; label: string }> = {
  auftrag: {
    bg: "border bg-red-50 dark:bg-red-500/15 border-red-200 dark:border-red-500/40",
    text: "text-red-800 dark:text-red-200",
    dot: "bg-red-500",
    ring: "hover:ring-2 hover:ring-red-300 dark:hover:ring-red-500/60",
    label: "Auftrag",
  },
  vermietung: {
    bg: "border bg-sky-50 dark:bg-sky-500/15 border-sky-200 dark:border-sky-500/40",
    text: "text-sky-800 dark:text-sky-200",
    dot: "bg-sky-400",
    ring: "hover:ring-2 hover:ring-sky-300 dark:hover:ring-sky-500/60",
    label: "Vermietung",
  },
  entwurf: {
    bg: "border bg-purple-50 dark:bg-purple-500/15 border-purple-200 dark:border-purple-500/40",
    text: "text-purple-800 dark:text-purple-200",
    dot: "bg-purple-500",
    ring: "hover:ring-2 hover:ring-purple-300 dark:hover:ring-purple-500/60",
    label: "Entwurf",
  },
};

interface PlacedBar {
  item: CalendarItem;
  startCol: number;
  endCol: number;
  lane: number;
  openLeft: boolean;  // Bar geht ueber Wochen-Anfang hinaus
  openRight: boolean; // Bar geht ueber Wochen-Ende hinaus
}

interface PlacedShift {
  shift: CalendarShift;
  col: number;
  lane: number;
}

// Shift-Style fuer "ohne Job" — neutral grau wie in der Wochenansicht.
const SHIFT_NEUTRAL = {
  bg: "border bg-foreground/[0.04] dark:bg-foreground/[0.08] border-foreground/15 dark:border-foreground/20",
  text: "text-foreground/80",
};

function fmtShiftTime(d: Date): string {
  return d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}

export function MonthView({ year, month, items, shifts, selectedDay, onSelectDay, onNavigate, onStandaloneShiftClick }: Props) {
  // Cells: 42 (6 Wochen × 7) — Prev/Next-Monat-Tage zur Kontext-Anzeige.
  const cells = useMemo<Cell[]>(() => {
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // 0=Mo
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    const arr: Cell[] = [];
    for (let i = firstWeekday - 1; i >= 0; i--) {
      arr.push({ date: new Date(year, month - 1, prevMonthLastDay - i), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      arr.push({ date: new Date(year, month, d), inMonth: true });
    }
    // Nur bis zum Ende der Woche auffuellen in der der letzte Monatstag liegt.
    // Keine zusaetzliche Komplett-Folge-Monat-Woche (vorher fest 42 Cells / 6
    // Wochen). Akzeptiert dass die Grid-Hoehe bei 5- vs 6-Wochen-Monaten
    // springt — Leos Wunsch: kein leerer Folge-Monat-Strip unten.
    const targetCount = Math.ceil(arr.length / 7) * 7;
    let nextDay = 1;
    while (arr.length < targetCount) {
      arr.push({ date: new Date(year, month + 1, nextDay++), inMonth: false });
    }
    return arr;
  }, [year, month]);

  // Pro-Woche-Lane-Packing: jeder Item kriegt fuer DIESE Woche eine Lane
  // (= Y-Position) und Spalten-Range. Laengster Span zuerst → niedrigste
  // Lane → Multi-Day-Bars stehen oben, Single-Day-Items darunter.
  const weekLayouts = useMemo(() => {
    const layouts: Array<{ bars: PlacedBar[]; placedShifts: PlacedShift[]; usedLanes: number }> = [];
    const dayMs = 86400000;

    const weekCount = cells.length / 7;
    for (let wi = 0; wi < weekCount; wi++) {
      const weekCells = cells.slice(wi * 7, wi * 7 + 7);
      const weekStart = new Date(weekCells[0].date.getFullYear(), weekCells[0].date.getMonth(), weekCells[0].date.getDate());
      const weekEnd = new Date(weekCells[6].date.getFullYear(), weekCells[6].date.getMonth(), weekCells[6].date.getDate());
      const ws = weekStart.getTime();
      const we = weekEnd.getTime();

      // Items die diese Woche beruehren
      const relevant: Array<{ item: CalendarItem; sMs: number; eMs: number }> = [];
      for (const item of items) {
        const s = new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate()).getTime();
        const e = item.endDate
          ? new Date(item.endDate.getFullYear(), item.endDate.getMonth(), item.endDate.getDate()).getTime()
          : s;
        if (e < ws || s > we) continue;
        relevant.push({ item, sMs: s, eMs: e });
      }
      relevant.sort((a, b) => {
        const aSpan = a.eMs - a.sMs;
        const bSpan = b.eMs - b.sMs;
        if (aSpan !== bSpan) return bSpan - aSpan;
        return a.sMs - b.sMs;
      });

      const lanes: boolean[][] = []; // lanes[laneIdx][col 0..6]
      const placed: PlacedBar[] = [];

      // 1. Multi-Day-Bars zuerst — niedrige Lanes, oben.
      for (const r of relevant) {
        const openLeft = r.sMs < ws;
        const openRight = r.eMs > we;
        const startCol = openLeft ? 0 : Math.round((r.sMs - ws) / dayMs);
        const endCol = openRight ? 6 : Math.round((r.eMs - ws) / dayMs);

        let lane = 0;
        while (true) {
          if (!lanes[lane]) lanes[lane] = new Array(7).fill(false);
          let free = true;
          for (let c = startCol; c <= endCol; c++) {
            if (lanes[lane][c]) { free = false; break; }
          }
          if (free) break;
          lane++;
        }
        for (let c = startCol; c <= endCol; c++) lanes[lane][c] = true;
        placed.push({ item: r.item, startCol, endCol, lane, openLeft, openRight });
      }

      // 2. Termine danach — single-col, sortiert nach Start-Zeit pro Tag.
      const relevantShifts: Array<{ shift: CalendarShift; col: number; sMs: number }> = [];
      for (const sh of shifts) {
        const day = new Date(sh.date.getFullYear(), sh.date.getMonth(), sh.date.getDate()).getTime();
        if (day < ws || day > we) continue;
        const col = Math.round((day - ws) / dayMs);
        relevantShifts.push({ shift: sh, col, sMs: sh.date.getTime() });
      }
      relevantShifts.sort((a, b) => a.sMs - b.sMs);

      const placedShifts: PlacedShift[] = [];
      for (const rs of relevantShifts) {
        let lane = 0;
        while (true) {
          if (!lanes[lane]) lanes[lane] = new Array(7).fill(false);
          if (!lanes[lane][rs.col]) break;
          lane++;
        }
        lanes[lane][rs.col] = true;
        placedShifts.push({ shift: rs.shift, col: rs.col, lane });
      }

      layouts.push({ bars: placed, placedShifts, usedLanes: lanes.length });
    }
    return layouts;
  }, [cells, items, shifts]);

  const todayKey = keyOf(new Date());

  const selectedDate = selectedDay ? new Date(year, month, selectedDay) : null;
  const selectedItems = useMemo(() => {
    if (!selectedDate) return [];
    const dt = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()).getTime();
    return items.filter((item) => {
      const s = new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate()).getTime();
      const e = item.endDate
        ? new Date(item.endDate.getFullYear(), item.endDate.getMonth(), item.endDate.getDate()).getTime()
        : s;
      return dt >= s && dt <= e;
    });
  }, [items, selectedDate]);

  const selectedShifts = useMemo(() => {
    if (!selectedDate) return [];
    const dt = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()).getTime();
    return shifts
      .filter((sh) => {
        const day = new Date(sh.date.getFullYear(), sh.date.getMonth(), sh.date.getDate()).getTime();
        return day === dt;
      })
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [shifts, selectedDate]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div>
        {/* Wochentag-Header */}
        <div className="grid grid-cols-7 mb-1.5">
          {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => (
            <div
              key={d}
              className="text-center text-[11px] font-semibold py-1.5 text-muted-foreground"
            >
              {d}
            </div>
          ))}
        </div>

        {/* 6 Wochen-Reihen, jede ein eigenes Grid */}
        <div className="rounded-xl overflow-hidden border bg-border flex flex-col gap-px">
          {weekLayouts.map((wl, wi) => {
            const week = cells.slice(wi * 7, wi * 7 + 7);
            const visibleLanes = Math.min(MAX_LANES_PER_WEEK, wl.usedLanes);
            const visibleBars = wl.bars.filter((b) => b.lane < visibleLanes);
            const visibleShifts = wl.placedShifts.filter((s) => s.lane < visibleLanes);

            // Overflow pro Spalte: belegte Lanes (Bars + Shifts) ueber MAX
            const overflow = new Array<number>(7).fill(0);
            for (const b of wl.bars) {
              if (b.lane >= visibleLanes) {
                for (let c = b.startCol; c <= b.endCol; c++) overflow[c]++;
              }
            }
            for (const s of wl.placedShifts) {
              if (s.lane >= visibleLanes) overflow[s.col]++;
            }

            // Row-Template: Header-Row + visibleLanes × LANE_HEIGHT + Padding-Row
            const lanesPart = visibleLanes > 0
              ? ` repeat(${visibleLanes}, ${LANE_HEIGHT_PX}px)`
              : "";
            const gridTemplateRows = `${HEADER_HEIGHT_PX}px${lanesPart} 1fr`;

            // minHeight: worst-case Hoehe damit alle Wochen gleich hoch sind
            // (Header + max Lanes × Lane-Hoehe + Gaps + Bottom-Padding).
            // Sonst springt das Layout je nach Belegung der Woche.
            const minHeight = HEADER_HEIGHT_PX + MAX_LANES_PER_WEEK * LANE_HEIGHT_PX + (MAX_LANES_PER_WEEK + 1) + 16;

            return (
              <div
                key={wi}
                className="grid grid-cols-7 gap-px bg-border"
                style={{ gridTemplateRows, minHeight }}
              >
                {/* BG-Layer: pro Spalte ein Button der die ganze Wochen-Hoehe
                    spannt — Klick-Flaeche + Cell-Tint + Tag-Nummer + Overflow.
                    z-0 damit Bars darueber rendern (z-10). */}
                {week.map((cell, col) => {
                  const cellKey = keyOf(cell.date);
                  const isSelected = cell.inMonth && cell.date.getDate() === selectedDay;
                  const isToday = cellKey === todayKey;

                  // Nur Aussen-Monat-Tage werden gedaempft. Wochenenden im
                  // aktuellen Monat sind normale Cells — Leo will keinen
                  // Sa/So-Tint, das verwirrt mehr als es hilft.
                  // WICHTIG: kein z-20 auf der Selected-Cell — sonst legt
                  // sich der bg-Layer ueber die Bars (z-10) und blendet
                  // die Auftraege im Tag aus. ring-inset gibt visuelle
                  // Markierung ohne Stack-Order zu aendern.
                  let cellBg = "bg-card";
                  if (!cell.inMonth) cellBg = "bg-muted/40";
                  else if (isSelected) cellBg = "bg-red-50/60 dark:bg-red-500/[0.08] ring-2 ring-red-400 ring-inset";
                  else if (isToday) cellBg = "bg-red-50/40 dark:bg-red-500/[0.08]";

                  return (
                    <button
                      key={cellKey}
                      type="button"
                      onClick={() => {
                        if (!cell.inMonth) {
                          onNavigate(cell.date);
                          return;
                        }
                        onSelectDay(cell.date.getDate() === selectedDay ? null : cell.date.getDate());
                      }}
                      style={{ gridColumn: col + 1, gridRow: "1 / -1" }}
                      className={`relative text-left transition-colors cursor-pointer ${cellBg} ${
                        isSelected
                          ? ""
                          : "hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.06]"
                      }`}
                    >
                      <span
                        className={`absolute top-1.5 left-2 inline-flex items-center justify-center text-[12px] font-semibold tabular-nums ${
                          !cell.inMonth ? "text-muted-foreground/50" :
                          isToday ? "w-6 h-6 rounded-full bg-red-500 text-white" :
                          "text-foreground/85"
                        }`}
                      >
                        {cell.date.getDate()}
                      </span>
                      {overflow[col] > 0 && cell.inMonth && (
                        <span className="absolute bottom-1.5 left-2 text-[10px] font-medium text-muted-foreground">
                          +{overflow[col]} weitere
                        </span>
                      )}
                    </button>
                  );
                })}

                {/* Bars: ein Element pro Wochen-Segment, spannt mehrere Spalten.
                    Bei Wochen-Umbruch (Sa→So-Wechsel zur naechsten Woche):
                      - Border auf der "offenen" Seite weg (border-l-0/r-0)
                      - Ecke nicht gerundet
                      - flush bis zum Spalten-Rand (kein mx-1)
                    So sieht's aus als ob der Bar einfach am Wochen-Ende
                    "abgeschnitten" wird und in der naechsten Woche weiter
                    laeuft — visueller Connect ohne tatsaechliches Span. */}
                {visibleBars.map((b) => {
                  const sty = TYPE_STYLE[b.item.type];
                  let round = "rounded";
                  if (b.openLeft && !b.openRight) round = "rounded-r rounded-l-none";
                  else if (!b.openLeft && b.openRight) round = "rounded-l rounded-r-none";
                  else if (b.openLeft && b.openRight) round = "rounded-none";
                  // ! erzwingt Override — sty.bg enthaelt `border` was sonst
                  // den `border-l-0`/`border-r-0` cascade-maessig schlucken kann.
                  const borderL = b.openLeft ? "!border-l-0" : "";
                  const borderR = b.openRight ? "!border-r-0" : "";
                  const ml = b.openLeft ? "" : "ml-1";
                  const mr = b.openRight ? "" : "mr-1";

                  return (
                    <button
                      key={`${b.item.id}-${wi}`}
                      type="button"
                      onClick={(e) => {
                        // Klick auf den Bar oeffnet die Tages-Details (Side-Panel)
                        // fuer den Tag UNTER dem Klick — nicht direkt den Auftrag.
                        // Im Panel kann der User dann gezielt zur Detail-Page.
                        // Tag wird via X-Position innerhalb des Bars bestimmt.
                        const rect = e.currentTarget.getBoundingClientRect();
                        const span = b.endCol - b.startCol + 1;
                        const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
                        const colInBar = Math.min(span - 1, Math.max(0, Math.floor(ratio * span)));
                        const cellDate = week[b.startCol + colInBar].date;
                        if (cellDate.getFullYear() === year && cellDate.getMonth() === month) {
                          onSelectDay(cellDate.getDate());
                        } else {
                          onNavigate(cellDate);
                        }
                      }}
                      style={{
                        gridColumn: `${b.startCol + 1} / ${b.endCol + 2}`,
                        gridRow: b.lane + 2,
                      }}
                      className={`relative z-10 self-center h-5 px-2 text-[10px] font-semibold leading-[18px] truncate cursor-pointer text-left ${sty.bg} ${borderL} ${borderR} ${sty.text} ${round} ${ml} ${mr} ${sty.ring} transition-all`}
                      data-tooltip={[b.item.title, b.item.customerName, b.item.locationName].filter(Boolean).join(" · ")}
                    >
                      {b.item.title}
                    </button>
                  );
                })}

                {/* Termine — single-col, kompakt mit Uhrzeit-Prefix.
                    Color-coded nach Job-Type wie in der Wochenansicht
                    (rot = Auftrag, sky = Vermietung, grau = ohne Job). */}
                {visibleShifts.map((p) => {
                  const sty = p.shift.jobType ? TYPE_STYLE[p.shift.jobType] : SHIFT_NEUTRAL;
                  const cellDate = week[p.col].date;
                  const startStr = fmtShiftTime(p.shift.date);
                  const label = p.shift.jobNumber
                    ? `${startStr} · INT-${p.shift.jobNumber}`
                    : `${startStr} · ${p.shift.title}`;
                  return (
                    <button
                      key={`shift-${p.shift.id}`}
                      type="button"
                      onClick={() => {
                        if (cellDate.getFullYear() === year && cellDate.getMonth() === month) {
                          onSelectDay(cellDate.getDate());
                        } else {
                          onNavigate(cellDate);
                        }
                      }}
                      style={{ gridColumn: p.col + 1, gridRow: p.lane + 2 }}
                      className={`relative z-10 self-center h-5 mx-1 px-1.5 text-[10px] font-medium leading-[18px] truncate rounded cursor-pointer text-left ${sty.bg} ${sty.text} transition-all`}
                      data-tooltip={[p.shift.title, p.shift.jobTitle, p.shift.assigneeName].filter(Boolean).join(" · ")}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Side-Panel — selected day's full info */}
      <aside className="lg:sticky lg:top-4 self-start">
        {selectedDate ? (
          <div className="rounded-xl border bg-card p-4 space-y-3">
            <header className="flex items-start justify-between gap-2 pb-3 border-b">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {selectedDate.toLocaleDateString("de-CH", { weekday: "long" })}
                </p>
                <p className="text-2xl font-bold leading-tight mt-0.5">
                  {selectedDate.toLocaleDateString("de-CH", { day: "numeric", month: "long" })}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {selectedDate.toLocaleDateString("de-CH", { year: "numeric" })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onSelectDay(null)}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Schliessen"
              >
                Schliessen
              </button>
            </header>
            {selectedItems.length === 0 && selectedShifts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Keine Einträge</p>
            ) : (() => {
              // Termine zu ihrem Auftrag gruppieren — Leo's Wunsch: nicht
              // mehr "Auftraege oben, Termine unten mit INT-Nr-Lookup", sondern
              // Termine direkt im Auftrag-Kasten geschachtelt. Orphans
              // (Termine ohne jobId oder mit jobId der nicht im View ist)
              // wandern in eine separate Sektion drunter.
              const itemIds = new Set(selectedItems.map((it) => it.id));
              const shiftsByItem = new Map<string, typeof selectedShifts>();
              const orphanShifts: typeof selectedShifts = [];
              for (const sh of selectedShifts) {
                if (sh.jobId && itemIds.has(sh.jobId)) {
                  const arr = shiftsByItem.get(sh.jobId) ?? [];
                  arr.push(sh);
                  shiftsByItem.set(sh.jobId, arr);
                } else {
                  orphanShifts.push(sh);
                }
              }

              const renderShift = (sh: typeof selectedShifts[number], showJobNr: boolean) => {
                const sty = sh.jobType ? TYPE_STYLE[sh.jobType] : SHIFT_NEUTRAL;
                const startStr = fmtShiftTime(sh.date);
                const endStr = sh.endDate ? fmtShiftTime(sh.endDate) : null;
                const inner = (
                  <>
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <span className="text-[11px] font-semibold tabular-nums">
                        {startStr}{endStr ? `–${endStr}` : ""}
                      </span>
                      {showJobNr && sh.jobNumber && (
                        <span className="text-[10px] font-mono font-bold opacity-70 shrink-0">
                          INT-{sh.jobNumber}
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-medium truncate">{sh.title}</div>
                    {sh.assigneeName && (
                      <div className="flex items-center gap-1 mt-0.5 text-[11px] opacity-75">
                        <User className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{sh.assigneeName}</span>
                      </div>
                    )}
                  </>
                );
                return sh.href ? (
                  <Link
                    key={sh.id}
                    href={sh.href}
                    className={`block p-2 rounded-lg ${sty.bg} ${sty.text} hover:shadow-sm transition-all`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {inner}
                  </Link>
                ) : onStandaloneShiftClick ? (
                  <button
                    key={sh.id}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onStandaloneShiftClick(sh.id); }}
                    className={`block w-full text-left p-2 rounded-lg ${sty.bg} ${sty.text} hover:shadow-sm transition-all`}
                    data-tooltip="Klicken zum Bearbeiten"
                  >
                    {inner}
                  </button>
                ) : (
                  <div key={sh.id} className={`block p-2 rounded-lg ${sty.bg} ${sty.text}`}>
                    {inner}
                  </div>
                );
              };

              return (
                <div className="space-y-3">
                  {(["auftrag", "vermietung", "entwurf"] as const).map((type) => {
                    const ofType = selectedItems.filter((it) => it.type === type);
                    if (ofType.length === 0) return null;
                    const sty = TYPE_STYLE[type];
                    const plural = ofType.length > 1
                      ? type === "auftrag" ? "Aufträge"
                      : type === "vermietung" ? "Vermietungen"
                      : "Entwürfe"
                      : sty.label;
                    return (
                      <Fragment key={type}>
                        <div>
                          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${sty.dot}`} />
                            {plural} ({ofType.length})
                          </h3>
                          <div className="space-y-1.5">
                            {ofType.map((item) => {
                              const itemShifts = shiftsByItem.get(item.id) ?? [];
                              return (
                                <div key={item.id} className={`rounded-lg ${sty.bg} ${sty.text} overflow-hidden`}>
                                  <Link
                                    href={item.href}
                                    className="block p-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-all group"
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <span className="font-semibold text-sm truncate">{item.title}</span>
                                      <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity shrink-0 mt-0.5" />
                                    </div>
                                    {(item.customerName || item.locationName) && (
                                      <div className="flex items-center gap-1 mt-1 text-[11px] opacity-80">
                                        <MapPin className="h-2.5 w-2.5 shrink-0" />
                                        <span className="truncate">
                                          {[item.customerName, item.locationName].filter(Boolean).join(" · ")}
                                        </span>
                                      </div>
                                    )}
                                  </Link>
                                  {itemShifts.length > 0 && (
                                    <div className="px-2 pb-2 space-y-1 bg-black/[0.04] dark:bg-white/[0.04]">
                                      <p className="text-[10px] font-semibold uppercase tracking-wider opacity-70 pt-1.5 px-1 flex items-center gap-1">
                                        <Clock className="h-2.5 w-2.5" />
                                        Termine ({itemShifts.length})
                                      </p>
                                      {itemShifts.map((sh) => renderShift(sh, false))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}

                  {/* Orphan-Termine (kein jobId oder Job nicht im View) */}
                  {orphanShifts.length > 0 && (
                    <div>
                      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                        <Clock className="h-3 w-3" />
                        Sonstige Termine ({orphanShifts.length})
                      </h3>
                      <div className="space-y-1.5">
                        {orphanShifts.map((sh) => renderShift(sh, true))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="hidden lg:block rounded-xl border border-dashed bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Tag wählen für Details
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
