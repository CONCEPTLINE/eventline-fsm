"use client";

/**
 * Kalender-Page: read-only Uebersicht ueber Aufträge, Vermietungen und
 * (in der Wochenansicht) Termine.
 *
 * Architektur:
 *   - Page = Controller: state, data-loading mit date-range Filter, Navigation
 *   - MonthView = reine Renderer fuer Monatsansicht (nur Aufträge + Vermietungen)
 *   - WeekView  = reine Renderer fuer Wochenansicht (zusätzlich Termine,
 *                 visuell gefärbt nach ihrem Auftrag)
 *
 * Daten:
 *   - jobs: Aufträge (status != 'anfrage' und != 'storniert') + Vermietungen
 *           (status = 'anfrage' und nicht stornierter Vermietentwurf)
 *   - job_appointments: Termine in der Range, mit Job-Join fuer den Bezug
 *
 * Skalierung:
 *   - Date-Range-Filter: nur Monat ±1 Buffer wird geladen (statt alles ever)
 *   - Reload bei Monats-Wechsel via useCallback+useEffect
 *   - Memoization in den Views (Date-Index)
 *
 * Termin-Erstellung passiert weiterhin in /auftraege/[id] (AppointmentsSection)
 * — der Kalender ist absichtlich read-only damit der Nutzer beim Plotten von
 * Schichten den Kontext des Auftrags hat.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { logError } from "@/lib/log";
import type { CalendarItem, CalendarShift, CalendarView, ItemType } from "@/components/kalender/types";
import { MonthView } from "@/components/kalender/month-view";
import { WeekView } from "@/components/kalender/week-view";
import { NeuerTerminModal } from "@/components/kalender/neuer-termin-modal";
import { TerminEditModal } from "@/components/kalender/termin-edit-modal";
import { IcalFeedBlock } from "@/components/kalender/ical-feed-block";
import { usePermissions } from "@/lib/use-permissions";

// Supabase-Joined-Shape — am API-Boundary getypt damit die Loader-Logik
// nicht durchgehend mit any/unknown rumhantieren muss.
interface RawJob {
  id: string;
  title: string;
  status: string;
  job_number: number | null;
  start_date: string | null;
  end_date: string | null;
  is_deleted: boolean | null;
  cancelled_as_anfrage: boolean | null;
  was_anfrage: boolean | null;
  guest_count: string | null;
  customer: { name: string } | null;
  location: { name: string } | null;
  room: { name: string } | null;
}

interface RawShift {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  job_id: string | null;
  assignee: { full_name: string } | null;
  job: { id: string; title: string; status: string; job_number: number | null; was_anfrage: boolean | null } | null;
}

export default function KalenderPage() {
  const supabase = createClient();
  const [view, setView] = useState<CalendarView>("monat");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [shifts, setShifts] = useState<CalendarShift[]>([]);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNeuerTermin, setShowNeuerTermin] = useState(false);
  // id eines geklickten Standalone-Termins (job_id=null) — oeffnet den
  // Edit/Delete-Modal. Auftrag-bezogene Termine fuehren weiter zur
  // Auftrag-Detail-Page (existing Link-behaviour in WeekView).
  const [editTerminId, setEditTerminId] = useState<string | null>(null);
  const { can } = usePermissions();

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthLabel = currentDate.toLocaleDateString("de-CH", { month: "long", year: "numeric" });

  // Wochen-Tage (Mo-So) basierend auf currentDate.
  const weekDays = useMemo<Date[]>(() => {
    const today = new Date(currentDate);
    const dayOfWeek = (today.getDay() + 6) % 7;
    const monday = new Date(today);
    monday.setDate(today.getDate() - dayOfWeek);
    const arr: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, [currentDate]);

  // Date-Range fuer Data-Loading: Monat ±1 Buffer. Buffer fängt Mehrtages-
  // Events ab die in den sichtbaren Monat reichen.
  const load = useCallback(async () => {
    setLoading(true);
    const rangeStart = new Date(year, month - 1, 1).toISOString();
    const rangeEnd = new Date(year, month + 2, 0, 23, 59, 59).toISOString();

    try {
      const [jobsRes, shiftsRes] = await Promise.all([
        supabase
          .from("jobs")
          .select("id, title, status, job_number, start_date, end_date, is_deleted, cancelled_as_anfrage, was_anfrage, guest_count, customer:customers(name), location:locations(name), room:rooms(name)")
          .not("start_date", "is", null)
          .neq("is_deleted", true)
          .gte("start_date", rangeStart)
          .lte("start_date", rangeEnd),
        supabase
          .from("job_appointments")
          .select("id, title, start_time, end_time, job_id, assignee:profiles!assigned_to(full_name), job:jobs(id, title, status, job_number, was_anfrage)")
          .not("start_time", "is", null)
          .gte("start_time", rangeStart)
          .lte("start_time", rangeEnd),
      ]);

      const calItems: CalendarItem[] = [];
      for (const j of (jobsRes.data ?? []) as unknown as RawJob[]) {
        if (!j.start_date) continue;
        if (j.status === "storniert") continue;
        // Vermietentwürfe die spaeter storniert wurden bleiben als
        // "cancelled_as_anfrage = true" — die ueberspringen wir.
        if (j.cancelled_as_anfrage === true) continue;
        // 3-Way-Mapping (Vermietentwuerfe gelten als Entwurf — gleiche lila Farbe):
        //   - status=anfrage|entwurf   → entwurf   (lila, Draft)
        //   - was_anfrage=true (sonst) → vermietung (hellblau, bestaetigt)
        //   - sonst                    → auftrag    (rot)
        const itemType: ItemType =
          j.status === "anfrage" || j.status === "entwurf" ? "entwurf"
          : j.was_anfrage ? "vermietung"
          : "auftrag";
        const isVermietung = j.status === "anfrage";
        const start = new Date(j.start_date);
        const end = j.end_date ? new Date(j.end_date) : undefined;
        const customerName = j.customer?.name ?? null;
        const locationName = j.location?.name ?? j.room?.name ?? null;
        // Beide Typen mit INT-Nr-Prefix: Vermietung zeigt Kunde, Auftrag den
        // Job-Titel. Konsistente Darstellung im Kalender — INT-Nr ist immer
        // der Anker zur Identifikation.
        const body = isVermietung ? (customerName ?? j.title) : j.title;
        const title = j.job_number != null ? `INT-${j.job_number} | ${body}` : body;
        calItems.push({
          id: j.id,
          type: itemType,
          jobNumber: j.job_number,
          title,
          date: start,
          endDate: end,
          customerName,
          locationName,
          href: isVermietung ? `/auftraege/vermietentwurf/${j.id}` : `/auftraege/${j.id}`,
        });
      }

      const calShifts: CalendarShift[] = [];
      for (const a of (shiftsRes.data ?? []) as unknown as RawShift[]) {
        const job = a.job;
        // Termine eines stornierten Auftrags ueberspringen — Konsistenz mit
        // calItems oben, wo storniert auch raus geht.
        if (job?.status === "storniert") continue;
        const start = new Date(a.start_time);
        const end = a.end_time ? new Date(a.end_time) : undefined;
        const jobType: CalendarShift["jobType"] = job
          ? job.status === "anfrage" || job.status === "entwurf" ? "entwurf"
          : job.was_anfrage ? "vermietung"
          : "auftrag"
          : null;
        calShifts.push({
          id: a.id,
          jobId: a.job_id,
          jobType,
          jobNumber: job?.job_number ?? null,
          jobTitle: job?.title ?? null,
          date: start,
          endDate: end,
          title: a.title,
          assigneeName: a.assignee?.full_name ?? null,
          // Routing: Vermietentwuerfe (status=anfrage) haben eine andere
          // Detail-Page als normale Auftraege/Entwuerfe.
          href: a.job_id
            ? job?.status === "anfrage"
              ? `/auftraege/vermietentwurf/${a.job_id}`
              : `/auftraege/${a.job_id}`
            : null,
        });
      }

      setItems(calItems);
      setShifts(calShifts);
    } catch (e) {
      logError("kalender.load", e);
    } finally {
      setLoading(false);
    }
  }, [supabase, year, month]);

  useEffect(() => { load(); }, [load]);

  // Navigation: in Wochenansicht +-7 Tage, in Monatsansicht +-1 Monat.
  function nav(direction: -1 | 1) {
    if (view === "woche") {
      const next = new Date(currentDate);
      next.setDate(next.getDate() + direction * 7);
      setCurrentDate(next);
    } else {
      setCurrentDate(new Date(year, month + direction, 1));
    }
    setSelectedDay(null);
  }
  function goToday() {
    setCurrentDate(new Date());
    setSelectedDay(null);
  }
  // Klick auf einen Tag des Vor-/Folge-Monats in der Monatsansicht: Sprung
  // zum entsprechenden Monat + Selektion des geklickten Tags.
  function navigateToDate(date: Date) {
    setCurrentDate(new Date(date.getFullYear(), date.getMonth(), 1));
    setSelectedDay(date.getDate());
  }

  // Header-Label fuer die aktuelle Range — Monat oder "KW 18 (28. Apr - 4. Mai)"
  const rangeLabel = view === "woche"
    ? (() => {
        // ISO-Wochen-Nr berechnen
        const target = new Date(weekDays[0]);
        target.setHours(0, 0, 0, 0);
        target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7));
        const week1 = new Date(target.getFullYear(), 0, 4);
        const weekNo = 1 + Math.round(((target.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
        const startStr = weekDays[0].toLocaleDateString("de-CH", { day: "numeric", month: "short" });
        const endStr = weekDays[6].toLocaleDateString("de-CH", { day: "numeric", month: "short", year: "numeric" });
        return `KW ${weekNo} · ${startStr} – ${endStr}`;
      })()
    : monthLabel;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Kalender</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Aufträge, Vermietungen{view === "woche" ? " & Termine" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {can("kalender:create") && (
            <button
              type="button"
              onClick={() => setShowNeuerTermin(true)}
              className="kasten kasten-red"
            >
              <Plus className="h-3.5 w-3.5" />
              Neuer Termin
            </button>
          )}
        </div>
      </div>

      <Card className="bg-card">
        <CardContent className="p-5 space-y-4">
          {/* Top-Bar: Range-Label links + Legende/Navigation/View-Toggle rechts */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-lg font-bold capitalize">{rangeLabel}</h2>
            <div className="flex items-center gap-3">
              {/* Legende — Vermietentwurf gilt als Entwurf (gleiche lila Farbe). */}
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
                  Entwurf
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={() => nav(-1)} className="h-8 w-8 p-0">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={goToday} className="h-8 px-3 text-xs">
                  Heute
                </Button>
                <Button variant="outline" size="sm" onClick={() => nav(1)} className="h-8 w-8 p-0">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              {/* View-Toggle — kasten-Pattern wie überall sonst (active vs toggle-off) */}
              <div className="flex p-0.5 bg-muted rounded-lg">
                {(["monat", "woche"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {v === "monat" ? "Monat" : "Woche"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {loading && items.length === 0 ? (
            <div className="h-96 rounded-xl bg-muted/40 animate-pulse" />
          ) : view === "monat" ? (
            <MonthView
              year={year}
              month={month}
              items={items}
              shifts={shifts}
              selectedDay={selectedDay}
              onSelectDay={setSelectedDay}
              onNavigate={navigateToDate}
              onStandaloneShiftClick={setEditTerminId}
            />
          ) : (
            // Mobile: horizontal scrollable wrapper damit das 8-Spalten-Grid
            // nicht klemmt. Desktop: kein Effekt weil min-width unter Desktop-
            // Breite liegt.
            <div className="-mx-3 sm:mx-0 overflow-x-auto">
              <div className="min-w-[760px] px-3 sm:px-0">
                <WeekView
                  weekDays={weekDays}
                  items={items}
                  shifts={shifts}
                  onStandaloneShiftClick={setEditTerminId}
                />
              </div>
            </div>
          )}

        </CardContent>
      </Card>

      {/* Persoenlicher iCal-Feed — jeder User kann hier seinen Token kopieren
          und in Google/Apple/Outlook abonnieren. Vorher nur in /einstellungen,
          aber Mitarbeiter ohne Settings-Zugriff hatten keinen Pfad dahin. */}
      <IcalFeedBlock
        title="Mein Kalender abonnieren"
        description={
          <>
            Persönlicher iCal-Feed mit deinen Aufträgen + Terminen. Kopiere die URL und füge sie in Google
            Calendar / Apple Calendar / Outlook über <span className="font-medium">&quot;Per URL hinzufügen&quot;</span> ein.
          </>
        }
      />

      <NeuerTerminModal
        open={showNeuerTermin}
        onClose={() => setShowNeuerTermin(false)}
        items={items}
        onCreated={load}
        // In Monatsansicht: ausgewaehlter Tag wird vorausgefuellt damit der
        // User nicht nochmal das Datum tippen muss.
        initialDate={view === "monat" && selectedDay != null ? new Date(year, month, selectedDay) : null}
      />

      <TerminEditModal
        apptId={editTerminId}
        onClose={() => setEditTerminId(null)}
        onChanged={load}
      />
    </div>
  );
}
