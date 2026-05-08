"use client";

/**
 * Belegungsplan-View — direkt von /locations unter der Schweizer Karte
 * eingebettet (ohne Page-Header — die Card ist alles was dort angezeigt
 * wird). Eigene /belegungsplan-Route gibt es nicht mehr.
 *
 * Architektur: CSS-Grid mit (1 Standort-Spalte + N Tag-Spalten) ×
 * (Header + M Location-Reihen). Buchungen werden zu "Runs" zusammen-
 * gefasst → Multi-Day = ein Bar-Element via grid-column-span (gleiches
 * Pattern wie Calendar-Monatsview). Color-System siehe fillFor().
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { ChevronLeft, ChevronRight, MapPin } from "lucide-react";

type Location = {
  id: string;
  name: string;
  address_city: string | null;
  capacity: number | null;
};

type BookingKind = "auftrag" | "vermietung" | "draft";

type Booking = {
  id: string;
  kind: BookingKind;
  location_id: string;
  job_number: number | null;
  title: string;
  start: Date;
  end: Date;
  status: string;
  customer_name: string | null;
  /** false wenn der User dem Auftrag nicht zugeteilt ist — Cell zeigt
   *  trotzdem "belegt", aber Details sind maskiert (kein Titel, keine
   *  INT-Nr, keine Kunden-Info). */
  visible: boolean;
};

interface Run {
  startCol: number;
  endCol: number;
  fill: string;
  bookings: Booking[];
  key: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function isToday(d: Date) {
  const t = new Date();
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}

const KIND_LABEL: Record<BookingKind, string> = {
  auftrag: "Auftrag",
  vermietung: "Vermietung",
  draft: "Vermietentwurf",
};

export function BelegungsplanView() {
  const supabase = createClient();
  const [locations, setLocations] = useState<Location[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState(30);
  const [anchorDate, setAnchorDate] = useState<Date>(() => startOfDay(new Date()));
  const [selectedRun, setSelectedRun] = useState<{ location: Location; bookings: Booking[] } | null>(null);

  useEffect(() => {
    load();
  }, [anchorDate, windowDays]);

  async function load() {
    setLoading(true);
    const start = anchorDate;
    const end = new Date(anchorDate.getTime() + windowDays * DAY_MS);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    // Locations via RLS (alle Mitarbeiter duerfen Standorte sehen).
    // Bookings via /api/belegungsplan: das Endpoint maskiert Auftrags-
    // Details fuer User die dem Job nicht zugeteilt sind, aber zeigt die
    // Belegung trotzdem. So ist die Kapazitaets-Sicht fuer alle gleich.
    const [locRes, bpRes] = await Promise.all([
      supabase
        .from("locations")
        .select("id, name, address_city, capacity")
        .eq("is_active", true)
        .order("name"),
      fetch(`/api/belegungsplan?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`)
        .then((r) => r.ok ? r.json() : Promise.resolve({ bookings: [] })),
    ]);

    setLocations((locRes.data as Location[]) ?? []);

    type ApiBooking = {
      id: string;
      job_number: number | null;
      title: string | null;
      status: string;
      was_anfrage: boolean | null;
      start_date: string;
      end_date: string | null;
      location_id: string;
      customer_name: string | null;
      visible: boolean;
    };

    const all: Booking[] = [];
    for (const j of (bpRes.bookings ?? []) as ApiBooking[]) {
      if (!j.start_date || !j.location_id) continue;
      if (j.status === "storniert") continue;
      const kind: BookingKind =
        j.status === "anfrage" || j.status === "entwurf" ? "draft"
        : j.was_anfrage ? "vermietung"
        : "auftrag";
      all.push({
        id: j.id,
        kind,
        location_id: j.location_id,
        job_number: j.job_number,
        title: j.title ?? "Belegt",
        start: startOfDay(new Date(j.start_date)),
        end: startOfDay(new Date(j.end_date ?? j.start_date)),
        status: j.status,
        customer_name: j.customer_name,
        visible: j.visible,
      });
    }
    setBookings(all);
    setLoading(false);
  }

  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < windowDays; i++) {
      arr.push(new Date(anchorDate.getTime() + i * DAY_MS));
    }
    return arr;
  }, [anchorDate, windowDays]);

  function cellBookings(locationId: string, day: Date): Booking[] {
    return bookings.filter((b) => b.location_id === locationId && day >= b.start && day <= b.end);
  }

  function fillFor(b: Booking[]): string {
    if (b.length === 0) return "";
    const hasConfirmed = b.some((x) => x.kind === "auftrag" || x.kind === "vermietung");
    const hasDraft = b.some((x) => x.kind === "draft");
    if (hasConfirmed && hasDraft) {
      return "border bg-red-50 dark:bg-red-500/15 border-red-300 dark:border-red-500/50 text-red-800 dark:text-red-200 [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(220,38,38,0.18)_4px,rgba(220,38,38,0.18)_8px)]";
    }
    if (b.some((x) => x.kind === "auftrag")) {
      return "border bg-red-50 dark:bg-red-500/15 border-red-200 dark:border-red-500/40 text-red-800 dark:text-red-200";
    }
    if (b.some((x) => x.kind === "vermietung")) {
      return "border bg-sky-50 dark:bg-sky-500/15 border-sky-200 dark:border-sky-500/40 text-sky-800 dark:text-sky-200";
    }
    return "border bg-purple-50 dark:bg-purple-500/15 border-purple-200 dark:border-purple-500/40 text-purple-800 dark:text-purple-200";
  }

  function computeRuns(locationId: string): Run[] {
    const out: Run[] = [];
    let cur: Run | null = null;
    for (let i = 0; i < days.length; i++) {
      const cb = cellBookings(locationId, days[i]);
      const key = cb.map((b) => b.id).sort().join(",");
      if (cb.length === 0) {
        if (cur) { out.push(cur); cur = null; }
        continue;
      }
      if (cur && cur.key === key) {
        cur.endCol = i;
      } else {
        if (cur) out.push(cur);
        cur = { startCol: i, endCol: i, fill: fillFor(cb), bookings: cb, key };
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function shiftDays(delta: number) {
    setAnchorDate((d) => startOfDay(new Date(d.getTime() + delta * DAY_MS)));
  }
  function goToday() {
    setAnchorDate(startOfDay(new Date()));
  }

  const rangeLabel = useMemo(() => {
    if (days.length === 0) return "";
    const first = days[0];
    const last = days[days.length - 1];
    const sameMonth = first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth();
    const lastStr = last.toLocaleDateString("de-CH", { day: "numeric", month: "short", year: "numeric" });
    return sameMonth
      ? `${first.getDate()}. – ${lastStr}`
      : `${first.toLocaleDateString("de-CH", { day: "numeric", month: "short" })} – ${lastStr}`;
  }, [days]);

  const gridTemplateColumns = `minmax(140px, 180px) repeat(${days.length}, minmax(28px, 1fr))`;

  return (
    <>
      <Card className="bg-card">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-lg font-bold">{rangeLabel}</h2>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-x-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                  Auftrag
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-sky-400" />
                  Vermietung
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
                  Vermietentwurf offen
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={() => shiftDays(-windowDays)} className="h-8 w-8 p-0">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={goToday} className="h-8 px-3 text-xs">
                  Heute
                </Button>
                <Button variant="outline" size="sm" onClick={() => shiftDays(windowDays)} className="h-8 w-8 p-0">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex p-0.5 bg-muted rounded-lg">
                {[14, 30, 60].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setWindowDays(n)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      windowDays === n
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {n} Tage
                  </button>
                ))}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="h-96 rounded-xl bg-muted/40 animate-pulse" />
          ) : locations.length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="Keine Standorte vorhanden"
              action={<Link href="/locations" className="kasten kasten-red">Standort anlegen</Link>}
            />
          ) : (
            <div className="rounded-xl overflow-hidden border bg-border">
              <div className="overflow-x-auto bg-card">
                <div
                  className="grid gap-px bg-border"
                  style={{ gridTemplateColumns }}
                >
                  <div className="sticky left-0 z-20 bg-muted/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Standort
                  </div>
                  {days.map((d, i) => {
                    const today = isToday(d);
                    const showMonth = d.getDate() === 1 || i === 0;
                    return (
                      <div
                        key={`hd-${i}`}
                        className={`text-center py-1.5 ${
                          today ? "bg-red-50 dark:bg-red-500/15" : "bg-muted/40"
                        }`}
                      >
                        <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 font-semibold leading-none h-3">
                          {showMonth ? d.toLocaleDateString("de-CH", { month: "short" }) : " "}
                        </div>
                        <div className={`text-[12px] font-bold tabular-nums leading-tight mt-0.5 ${today ? "text-red-600 dark:text-red-300" : ""}`}>
                          {d.getDate()}
                        </div>
                        <div className={`text-[9px] leading-none ${today ? "text-red-600/80 dark:text-red-300/80" : "text-muted-foreground/60"}`}>
                          {["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getDay()]}
                        </div>
                      </div>
                    );
                  })}

                  {locations.map((loc, li) => {
                    const runs = computeRuns(loc.id);
                    const rowIdx = li + 2;
                    return (
                      <Fragment key={loc.id}>
                        <div
                          className="sticky left-0 z-20 bg-card px-3 py-2 text-sm font-medium truncate"
                          style={{ gridRow: rowIdx }}
                        >
                          <div className="truncate">{loc.name}</div>
                          {(loc.address_city || loc.capacity) && (
                            <div className="text-[10px] font-normal text-muted-foreground truncate">
                              {[loc.address_city, loc.capacity ? `${loc.capacity} Pers.` : null].filter(Boolean).join(" · ")}
                            </div>
                          )}
                        </div>
                        {days.map((d, di) => {
                          const today = isToday(d);
                          return (
                            <div
                              key={`bg-${loc.id}-${di}`}
                              style={{ gridRow: rowIdx, gridColumn: di + 2 }}
                              className={`min-h-[40px] ${
                                today ? "bg-red-50/40 dark:bg-red-500/[0.08]" : "bg-card"
                              }`}
                            />
                          );
                        })}
                        {runs.map((run, ri) => {
                          const first = run.bookings[0];
                          // Maskiert: wenn keiner der Bookings im Run sichtbar ist, zeige
                          // "Belegt" statt INT-Nr — User weiss "an dem Tag ist was"
                          // ohne Auftrags-Details zu sehen.
                          const anyVisible = run.bookings.some((b) => b.visible);
                          const label = anyVisible
                            ? (first.job_number ? `INT-${first.job_number}` : "")
                            : "Belegt";
                          return (
                            <button
                              key={`run-${loc.id}-${ri}`}
                              type="button"
                              style={{
                                gridColumn: `${run.startCol + 2} / ${run.endCol + 3}`,
                                gridRow: rowIdx,
                              }}
                              className={`relative z-10 m-1 rounded text-[10px] font-semibold text-left px-2 truncate hover:ring-2 hover:ring-foreground/40 hover:ring-inset transition-all ${run.fill}`}
                              onClick={() => setSelectedRun({ location: loc, bookings: run.bookings })}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Modal
        open={!!selectedRun}
        onClose={() => setSelectedRun(null)}
        title={selectedRun?.location.name}
        icon={<MapPin className="h-5 w-5 text-muted-foreground" />}
        size="md"
      >
        {selectedRun?.bookings.map((b) => {
          const dotClass =
            b.kind === "auftrag" ? "bg-red-500"
            : b.kind === "vermietung" ? "bg-sky-400"
            : "bg-purple-500";

          // Nicht-zugeteilt: nur Datum + Hinweis, kein Link, keine Details.
          if (!b.visible) {
            return (
              <div
                key={`${b.kind}-${b.id}`}
                className="block rounded-lg border border-dashed p-3 bg-muted/20"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className={`h-2 w-2 rounded-full ${dotClass} opacity-50`} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Belegt
                  </span>
                </div>
                <p className="text-sm text-muted-foreground italic">
                  Du bist diesem Auftrag nicht zugeteilt.
                </p>
                <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {b.start.toLocaleDateString("de-CH", { day: "numeric", month: "short" })}
                  {b.end.getTime() !== b.start.getTime() &&
                    ` – ${b.end.toLocaleDateString("de-CH", { day: "numeric", month: "short" })}`}
                </p>
              </div>
            );
          }

          const href = b.kind === "draft" && b.status === "anfrage"
            ? `/auftraege/vermietentwurf/${b.id}`
            : `/auftraege/${b.id}`;
          return (
            <Link
              key={`${b.kind}-${b.id}`}
              href={href}
              onClick={() => setSelectedRun(null)}
              className="block rounded-lg border p-3 hover:bg-muted/40 transition"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`h-2 w-2 rounded-full ${dotClass}`} />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {KIND_LABEL[b.kind]}
                </span>
                {b.job_number && (
                  <span className="text-[10px] font-mono font-bold opacity-70 ml-auto">
                    INT-{b.job_number}
                  </span>
                )}
              </div>
              <p className="text-sm font-medium">{b.title}</p>
              {b.customer_name && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {b.customer_name}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {b.start.toLocaleDateString("de-CH", { day: "numeric", month: "short" })}
                {b.end.getTime() !== b.start.getTime() &&
                  ` – ${b.end.toLocaleDateString("de-CH", { day: "numeric", month: "short" })}`}
              </p>
            </Link>
          );
        })}
      </Modal>
    </>
  );
}
