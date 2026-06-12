"use client";

/**
 * Wochenansicht — Aufträge/Vermietungen oben als Multi-Day-Stripes,
 * darunter Mitarbeiter-Zeile-Grid (Planday-Style).
 *
 * Bottom-Layout: 8-Spalten-Grid = 1 Mitarbeiter-Spalte + 7 Tag-Spalten.
 * Jede Zeile = ein Mitarbeiter, in jeder (Mitarbeiter, Tag)-Zelle stehen
 * dessen Termine an dem Tag chronologisch. So sieht man auf einen Blick
 * wer wann was hat — die zentrale Frage in der Schichtplanung.
 *
 * Termine erben weiterhin die Farbe ihres Auftrags (rot = Auftrag,
 * hellblau = Vermietung, grau = ohne Job-Bezug) + INT-Nr-Badge fuer den
 * zweiten visuellen Anker zur Auftrag-Zuordnung.
 */

import { Fragment, useMemo } from "react";
import Link from "next/link";
import { Clock, User, Plane } from "lucide-react";
import type { BvgPersonForecast, CalendarItem, CalendarShift, CalendarTimeOff } from "./types";

const TIME_OFF_LABEL: Record<CalendarTimeOff["type"], string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Komp-Tag",
  frei: "Frei",
};

interface Props {
  weekDays: Date[];
  items: CalendarItem[];
  shifts: CalendarShift[];
  /** Klick auf einen Termin ohne Job-Bezug (kein href). Optional —
   *  wenn nicht gesetzt, bleibt der Termin static. */
  onStandaloneShiftClick?: (shiftId: string) => void;
  /** BVG-Forecast pro Profile-ID fuer den sichtbaren Monat — wird als
   *  Pille neben dem Namen gerendert. Nur Personen mit Forecast bekommen
   *  eine Pille (Stunden-Lohn nicht hinterlegt -> keine Pille). */
  bvgByPerson?: Map<string, BvgPersonForecast>;
  /** Genehmigte Abwesenheiten — dezenter Marker (Plane-Icon) im
   *  jeweiligen (Person, Tag)-Cell, tooltip mit Typ. */
  timeOffs?: CalendarTimeOff[];
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}

const ITEM_STYLE: Record<CalendarItem["type"], { bg: string; text: string; ring: string }> = {
  auftrag: {
    bg: "bg-red-50 dark:bg-red-500/15 border-red-200 dark:border-red-500/40",
    text: "text-red-700 dark:text-red-300",
    ring: "ring-red-300 dark:ring-red-500/60",
  },
  vermietung: {
    bg: "bg-sky-50 dark:bg-sky-500/15 border-sky-200 dark:border-sky-500/40",
    text: "text-sky-700 dark:text-sky-300",
    ring: "ring-sky-300 dark:ring-sky-500/60",
  },
  entwurf: {
    bg: "bg-purple-50 dark:bg-purple-500/15 border-purple-200 dark:border-purple-500/40",
    text: "text-purple-700 dark:text-purple-300",
    ring: "ring-purple-300 dark:ring-purple-500/60",
  },
};

// Termin ohne Job-Bezug. Neutral-grau damit's nicht mit Auftrags-Termine
// (rot/hellblau) verwechselt wird.
const SHIFT_STYLE_NEUTRAL = {
  bg: "bg-foreground/[0.04] dark:bg-foreground/[0.08] border-foreground/15 dark:border-foreground/20",
  text: "text-foreground/80",
};

export function WeekView({ weekDays, items, shifts, onStandaloneShiftClick, bvgByPerson, timeOffs }: Props) {
  // Lookup-Map (personId-dateKey -> TimeOff-Typ) fuer schnelle pro-Cell-
  // Pruefung. Built once pro Render-Cycle, NICHT pro Cell.
  const timeOffByPersonDay = useMemo(() => {
    const map = new Map<string, CalendarTimeOff>();
    if (!timeOffs) return map;
    const toKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    for (const t of timeOffs) {
      const cursor = new Date(t.startDate);
      const endTs = new Date(t.endDate.getFullYear(), t.endDate.getMonth(), t.endDate.getDate()).getTime();
      while (cursor.getTime() <= endTs) {
        map.set(`${t.userId}-${toKey(cursor)}`, t);
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return map;
  }, [timeOffs]);
  const todayKey = keyOf(new Date());
  const weekStartTs = new Date(weekDays[0].getFullYear(), weekDays[0].getMonth(), weekDays[0].getDate()).getTime();
  const weekEndTs = new Date(weekDays[6].getFullYear(), weekDays[6].getMonth(), weekDays[6].getDate()).getTime();

  // Stripes — Aufträge + Vermietungen geclamped auf die Woche, mit Spalten-Coords.
  // Ohne Lane-Packing: ueberlappende Stripes stapeln vertikal. Bei wenig
  // ueberlappenden Buchungen pro Woche reicht das.
  const stripes = useMemo(() => {
    const dayCol = new Map<string, number>();
    weekDays.forEach((d, i) => dayCol.set(keyOf(d), i));
    const out: Array<CalendarItem & { startCol: number; endCol: number; openLeft: boolean; openRight: boolean }> = [];
    for (const item of items) {
      const itemStart = new Date(item.date.getFullYear(), item.date.getMonth(), item.date.getDate()).getTime();
      const itemEndDate = item.endDate ?? item.date;
      const itemEnd = new Date(itemEndDate.getFullYear(), itemEndDate.getMonth(), itemEndDate.getDate()).getTime();
      if (itemEnd < weekStartTs || itemStart > weekEndTs) continue;
      const openLeft = itemStart < weekStartTs;
      const openRight = itemEnd > weekEndTs;
      const startCol = openLeft ? 0 : dayCol.get(keyOf(item.date)) ?? 0;
      const endCol = openRight ? 6 : dayCol.get(keyOf(itemEndDate)) ?? 6;
      out.push({ ...item, startCol, endCol, openLeft, openRight });
    }
    out.sort((a, b) => a.startCol - b.startCol || a.date.getTime() - b.date.getTime());
    return out;
  }, [items, weekDays, weekStartTs, weekEndTs]);

  // Mitarbeiter-Gruppen — pro Person die Termine der Woche, chronologisch.
  // Sortierung: alphabetisch nach Name; "Unzugewiesen" ans Ende.
  // Key = assigneeId (UUID) damit Namens-Dubletten getrennt bleiben + Lookup
  // gegen bvgByPerson direkt moeglich ist.
  const personRows = useMemo(() => {
    const map = new Map<string, { id: string | null; name: string; isUnassigned: boolean; shifts: CalendarShift[] }>();
    for (const s of shifts) {
      const key = s.assigneeId ?? "__unassigned";
      if (!map.has(key)) {
        map.set(key, {
          id: s.assigneeId,
          name: s.assigneeName ?? "Ohne Zuweisung",
          isUnassigned: !s.assigneeId,
          shifts: [],
        });
      }
      map.get(key)!.shifts.push(s);
    }
    for (const g of map.values()) {
      g.shifts.sort((a, b) => a.date.getTime() - b.date.getTime());
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.isUnassigned !== b.isUnassigned) return a.isUnassigned ? 1 : -1;
      return a.name.localeCompare(b.name, "de");
    });
  }, [shifts]);

  const totalShiftsThisWeek = shifts.length;
  const hasContent = stripes.length > 0 || totalShiftsThisWeek > 0;

  return (
    <div className="space-y-4">
      {/* Tag-Header + Stripes-Section in einem Grid */}
      <div
        className="grid gap-px bg-border rounded-xl overflow-hidden border"
        style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}
      >
        {weekDays.map((d) => {
          const isToday = keyOf(d) === todayKey;
          return (
            <div
              key={keyOf(d)}
              className={`p-3 text-center ${isToday ? "bg-red-50 dark:bg-red-500/15" : "bg-card"}`}
            >
              <div className={`text-[10px] font-semibold uppercase tracking-wider ${isToday ? "text-red-600 dark:text-red-300" : "text-muted-foreground"}`}>
                {d.toLocaleDateString("de-CH", { weekday: "short" })}
              </div>
              <div className={`text-2xl font-bold mt-0.5 ${isToday ? "text-red-600 dark:text-red-300" : ""}`}>
                {d.getDate()}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {d.toLocaleDateString("de-CH", { month: "short" })}
              </div>
            </div>
          );
        })}

        {/* Stripes — Auftraege + Vermietungen, ueber mehrere Spalten gespannt.
            Bei Wochen-Umbruch (Item geht ueber den sichtbaren Range hinaus):
            Border + Rounding an der offenen Seite weg, flush bis zum Spalten-
            rand. So sieht man dass der Auftrag weiterlaeuft, statt einer
            geschlossenen Box. */}
        {stripes.length > 0 && stripes.map((s) => {
          const sty = ITEM_STYLE[s.type];
          let round = "rounded-lg";
          if (s.openLeft && !s.openRight) round = "rounded-r-lg rounded-l-none";
          else if (!s.openLeft && s.openRight) round = "rounded-l-lg rounded-r-none";
          else if (s.openLeft && s.openRight) round = "rounded-none";
          const borderL = s.openLeft ? "!border-l-0" : "";
          const borderR = s.openRight ? "!border-r-0" : "";
          const ml = s.openLeft ? "" : "ml-1";
          const mr = s.openRight ? "" : "mr-1";
          return (
            <Link
              key={s.id}
              href={s.href}
              style={{ gridColumn: `${s.startCol + 1} / ${s.endCol + 2}` }}
              className={`min-w-0 my-1 ${ml} ${mr} px-2.5 py-1.5 ${round} text-[11px] font-semibold border ${borderL} ${borderR} ${sty.bg} ${sty.text} truncate hover:shadow-sm transition-all`}
              data-tooltip={[s.title, s.customerName, s.locationName].filter(Boolean).join(" · ")}
            >
              <span className="truncate">{s.title}</span>
              {s.locationName && (
                <span className="ml-2 opacity-60 font-normal">· {s.locationName}</span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Mitarbeiter-Termine — Person × Tag-Grid (Planday-Style) */}
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-2">
          <Clock className="h-3 w-3" />
          Mitarbeiter-Termine
          {totalShiftsThisWeek > 0 && <span className="text-muted-foreground/70">({totalShiftsThisWeek})</span>}
        </div>
        {!hasContent ? (
          <div className="rounded-xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
            Keine Einträge in dieser Woche
          </div>
        ) : personRows.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card p-6 text-center text-xs text-muted-foreground">
            Keine Termine in dieser Woche
          </div>
        ) : (
          <div
            className="grid rounded-xl overflow-hidden border bg-border gap-px"
            style={{ gridTemplateColumns: "minmax(140px, 180px) repeat(7, minmax(0, 1fr))" }}
          >
            {/* Header: leere Mitarbeiter-Zelle + 7 Tag-Header */}
            <div className="bg-muted/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <User className="h-3 w-3" />
              Mitarbeiter
            </div>
            {weekDays.map((d) => {
              const isToday = keyOf(d) === todayKey;
              return (
                <div
                  key={`hd-${keyOf(d)}`}
                  className={`px-2 py-2 text-center ${isToday ? "bg-red-50 dark:bg-red-500/15" : "bg-muted/40"}`}
                >
                  <div className={`text-[10px] font-semibold uppercase tracking-wider ${isToday ? "text-red-600 dark:text-red-300" : "text-muted-foreground"}`}>
                    {d.toLocaleDateString("de-CH", { weekday: "short" })}
                  </div>
                  <div className={`text-sm font-bold tabular-nums ${isToday ? "text-red-600 dark:text-red-300" : ""}`}>
                    {d.getDate()}
                  </div>
                </div>
              );
            })}

            {/* Person-Zeilen */}
            {personRows.map((g) => {
              const bvg = g.id ? bvgByPerson?.get(g.id) : undefined;
              const bvgPct = bvg ? Math.min(100, Math.round((bvg.chf / bvg.threshold) * 100)) : 0;
              const bvgStyle = bvg
                ? bvg.status === "crit" ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40"
                : bvg.status === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
                : "bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/30"
                : "";
              return (
              <Fragment key={g.id ?? `noname-${g.name}`}>
                <div className={`bg-card px-3 py-2 text-sm font-medium truncate flex items-center justify-between gap-2 ${g.isUnassigned ? "text-muted-foreground italic" : ""}`}>
                  <span className="truncate">{g.name}</span>
                  {bvg && (
                    <span
                      className={`shrink-0 text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded border ${bvgStyle}`}
                      data-tooltip={`BVG-Forecast: ${Math.round(bvg.chf).toLocaleString("de-CH")} / ${Math.round(bvg.threshold).toLocaleString("de-CH")} CHF (${bvgPct}%)`}
                    >
                      {bvgPct}%
                    </span>
                  )}
                </div>
                {weekDays.map((d) => {
                  const k = keyOf(d);
                  const dayShifts = g.shifts.filter((s) => keyOf(s.date) === k);
                  const isToday = k === todayKey;
                  const off = g.id ? timeOffByPersonDay.get(`${g.id}-${k}`) : undefined;
                  // Abwesenheit dezent: leichter Blau-Tint (HR-Ferien-Farbe)
                  // im Cell-Background + Plane-Icon top-right mit Tooltip.
                  // Konsistent mit den Bottom-Stripes in der Monatsansicht.
                  const offBg = off ? "bg-blue-50/60 dark:bg-blue-500/[0.08]" : "";
                  return (
                    <div
                      key={`${g.name}-${k}`}
                      className={`relative p-1 space-y-1 min-h-[64px] ${isToday ? "bg-red-50/40 dark:bg-red-500/[0.06]" : offBg ? offBg : "bg-card"}`}
                    >
                      {off && (
                        <span
                          className="absolute top-1 right-1 z-[1] text-blue-500/70 dark:text-blue-400/70"
                          data-tooltip={`${TIME_OFF_LABEL[off.type]} — ${g.name}`}
                        >
                          <Plane className="h-3 w-3" />
                        </span>
                      )}
                      {dayShifts.map((s) => {
                        const sty = s.jobType ? ITEM_STYLE[s.jobType] : SHIFT_STYLE_NEUTRAL;
                        const startStr = fmtTime(s.date);
                        const endStr = s.endDate ? fmtTime(s.endDate) : null;
                        const inner = (
                          <>
                            <div className="flex items-center justify-between gap-1 mb-0.5">
                              <span className="text-[10px] font-semibold tabular-nums">
                                {startStr}{endStr ? `–${endStr}` : ""}
                              </span>
                              {s.jobNumber && (
                                <span className="text-[9px] font-mono font-bold opacity-70 shrink-0">
                                  INT-{s.jobNumber}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] font-medium truncate">{s.title}</div>
                          </>
                        );
                        const baseClasses = `block p-1.5 rounded-lg border ${sty.bg} ${sty.text}`;
                        const hoverClasses = "hover:shadow-sm hover:scale-[1.02] transition-all";
                        const tipText = s.jobTitle ? `${s.jobTitle} · ${s.title}` : s.title;
                        return s.href ? (
                          <Link
                            key={s.id}
                            href={s.href}
                            className={`${baseClasses} ${hoverClasses}`}
                            data-tooltip={tipText}
                          >
                            {inner}
                          </Link>
                        ) : onStandaloneShiftClick ? (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => onStandaloneShiftClick(s.id)}
                            className={`${baseClasses} ${hoverClasses} text-left w-full`}
                            data-tooltip={`${tipText} · klicken zum Bearbeiten`}
                          >
                            {inner}
                          </button>
                        ) : (
                          <div key={s.id} className={baseClasses} data-tooltip={tipText}>
                            {inner}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
