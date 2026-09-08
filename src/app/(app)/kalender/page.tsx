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
 *   - jobs: Aufträge (status != 'storniert', legacy status='anfrage' /
 *           frueher Vermietentwurf-Pipeline / ausgeblendet)
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

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Plus, CalendarDays } from "lucide-react";
import { logError } from "@/lib/log";
import type { BvgPersonForecast, CalendarItem, CalendarShift, CalendarTimeOff, CalendarView, ItemType } from "@/components/kalender/types";
import { calculateForecast, monthRange, forecastStatus } from "@/lib/bvg-forecast";
import { MonthView } from "@/components/kalender/month-view";
import { WeekView } from "@/components/kalender/week-view";
import { IcalFeedBlock } from "@/components/kalender/ical-feed-block";
import { Spinner } from "@/components/ui/spinner";
import dynamic from "next/dynamic";
import { usePermissions } from "@/lib/use-permissions";
import { todayLocalIso } from "@/lib/swiss-time";
import { useSearchParams } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";

/** Sofortiges Lade-Feedback (§7) waehrend ein Modal-Chunk nachlaedt:
 *  gleicher Backdrop wie die Modal-Komponente + zentrierter Spinner. */
function ModalChunkLoading() {
  return (
    <div className="fixed inset-0 z-[1100] bg-black/60 backdrop-blur flex items-center justify-center">
      <Spinner size={24} />
    </div>
  );
}

// Termin-Modals lazy laden (next/dynamic, ssr:false) und erst beim Oeffnen
// mounten — beide (~36 KB Quelle) oeffnen nur nach Klick (Plus-Button bzw.
// Standalone-Termin-Klick) und gehoeren nicht in den Erst-Render-Chunk der
// haeufig besuchten Kalender-Route. Die Modal-Komponente hat keine Exit-
// Animation und laedt ihre Daten selbst bei open/apptId → Conditional-Mount
// ist verlustfrei.
const NeuerTerminModal = dynamic(
  () => import("@/components/kalender/neuer-termin-modal").then((m) => m.NeuerTerminModal),
  { ssr: false, loading: () => <ModalChunkLoading /> },
);
const TerminEditModal = dynamic(
  () => import("@/components/kalender/termin-edit-modal").then((m) => m.TerminEditModal),
  { ssr: false, loading: () => <ModalChunkLoading /> },
);

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
  meeting_link: string | null;
  job_id: string | null;
  assigned_to: string | null;
  assignee: { full_name: string } | null;
  job: { id: string; title: string; status: string; job_number: number | null; was_anfrage: boolean | null } | null;
}

interface RawTimeOff {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  type: "ferien" | "krank" | "kompensation" | "frei" | "militaer";
  user: { full_name: string } | null;
}

export default function KalenderPage() {
  const supabase = createClient();
  // BackButton nur zeigen wenn ueber Dashboard-Link (?from=dashboard) hier
  // gelandet — bei Sidebar-Navigation gibt's keinen Zurueck-Kontext.
  const searchParams = useSearchParams();
  const fromDashboard = searchParams.get("from") === "dashboard";
  // Auf Mobile starten wir mit der Wochen-Ansicht — das Monats-Grid (7×6)
  // ist auf < 768px nicht sinnvoll bedienbar (Cells werden < 50px breit,
  // INT-Nrn schneiden ab). Auf Desktop bleibt Default = monat.
  const [view, setView] = useState<CalendarView>(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) return "woche";
    return "monat";
  });
  const [currentDate, setCurrentDate] = useState(new Date());
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [shifts, setShifts] = useState<CalendarShift[]>([]);
  const [timeOffs, setTimeOffs] = useState<CalendarTimeOff[]>([]);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNeuerTermin, setShowNeuerTermin] = useState(false);
  // id eines geklickten Standalone-Termins (job_id=null) — oeffnet den
  // Edit/Delete-Modal. Auftrag-bezogene Termine fuehren weiter zur
  // Auftrag-Detail-Page (existing Link-behaviour in WeekView).
  const [editTerminId, setEditTerminId] = useState<string | null>(null);
  // iCal-Feed-Popover: Icon-Button oben rechts oeffnet ein Overlay mit dem
  // IcalFeedBlock. Click-outside + Esc schliessen.
  const [icalOpen, setIcalOpen] = useState(false);
  const icalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!icalOpen) return;
    function onOutside(e: MouseEvent) {
      if (!icalRef.current) return;
      if (!icalRef.current.contains(e.target as Node)) setIcalOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIcalOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [icalOpen]);
  // BVG-Forecast pro Person fuer den aktuell sichtbaren Monat — wird in der
  // Wochenansicht als Pille neben dem Namen gerendert. Nur in der Woche
  // relevant (im Monat sieht man keine Person-Zeilen).
  const [bvgByPerson, setBvgByPerson] = useState<Map<string, BvgPersonForecast>>(new Map());
  // Cache pro Monats-Key ("YYYY-M") — Wochenwechsel INNERHALB desselben
  // Monats loest damit keinen Refetch der drei BVG-Queries mehr aus
  // (Threshold-RPC, komplette employee_compensation, Monats-Termine).
  // Termin-Saves invalidieren den Cache via handleTerminChanged (der
  // Forecast haengt an den Monats-Terminen), bvgRefreshKey erzwingt dann
  // den Refetch fuer den aktuell sichtbaren Monat.
  const bvgCacheRef = useRef<Map<string, Map<string, BvgPersonForecast>>>(new Map());
  const [bvgRefreshKey, setBvgRefreshKey] = useState(0);
  const { can } = usePermissions();

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthLabel = currentDate.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", month: "long", year: "numeric" });

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
    // TZ-Falle (§4): new Date(y, m, d).toISOString() serialisiert LOCAL-
    // Mitternacht als UTC — bei einem Client in anderer TZ als Zurich
    // verschieben sich die Grenzen und Events am Rand verschwinden.
    // Wir setzen die Range in UTC an und geben +/- 3h Puffer (Zurich
    // ist UTC+1/+2), sodass alles ab Zurich-Mitternacht des Buffer-Monats
    // bis Zurich-23:59 des End-Monats sicher enthalten ist.
    const TZ_BUFFER_MS = 3 * 60 * 60 * 1000;
    const rangeStart = new Date(Date.UTC(year, month - 1, 1) - TZ_BUFFER_MS).toISOString();
    const rangeEnd = new Date(Date.UTC(year, month + 2, 1) + TZ_BUFFER_MS).toISOString();
    // time_off arbeitet auf Date-Only — separate Range-Strings.
    const toDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const rangeStartDate = toDateStr(new Date(year, month - 1, 1));
    const rangeEndDate = toDateStr(new Date(year, month + 2, 0));

    try {
      const [jobsRes, shiftsRes, timeOffRes, projApptsRes] = await Promise.all([
        supabase
          .from("jobs")
          .select("id, title, status, job_number, start_date, end_date, is_deleted, cancelled_as_anfrage, was_anfrage, guest_count, customer:customers(name), location:locations(name), room:rooms(name)")
          .not("start_date", "is", null)
          .neq("is_deleted", true)
          .gte("start_date", rangeStart)
          .lte("start_date", rangeEnd),
        supabase
          .from("job_appointments")
          .select("id, title, start_time, end_time, meeting_link, job_id, assigned_to, assignee:profiles!assigned_to(full_name), job:jobs(id, title, status, job_number, was_anfrage)")
          .not("start_time", "is", null)
          .gte("start_time", rangeStart)
          .lte("start_time", rangeEnd),
        supabase
          .from("time_off")
          .select("id, user_id, start_date, end_date, type, user:profiles!user_id(full_name)")
          .eq("status", "genehmigt")
          .gte("end_date", rangeStartDate)
          .lte("start_date", rangeEndDate),
        supabase
          .from("project_appointments")
          .select("id, title, start_time, end_time, assigned_to, assignee:profiles!project_appointments_assigned_to_fkey(full_name), project:projects!project_id(id, project_number, title, status)")
          .gte("start_time", rangeStart)
          .lte("start_time", rangeEnd),
      ]);

      const calItems: CalendarItem[] = [];
      for (const j of (jobsRes.data ?? []) as unknown as RawJob[]) {
        if (!j.start_date) continue;
        if (j.status === "storniert") continue;
        // Legacy Vermietentwuerfe (status='anfrage') werden nicht mehr
        // gezeigt — die Pipeline ist 2026-09 weggefallen, Auftrags-
        // Entwuerfe leben ab Migration 206 in job_drafts (/entwuerfe).
        if (j.status === "anfrage") continue;
        // Alt-Records mit cancelled_as_anfrage=true bleiben ebenfalls ausgeblendet.
        if (j.cancelled_as_anfrage === true) continue;
        // 2-Way-Mapping (status='entwurf' ist nur Legacy — neue Entwuerfe
        // liegen in job_drafts und werden nicht ueber diese Query geladen):
        //   - status=entwurf           → entwurf    (lila, Legacy)
        //   - was_anfrage=true (sonst) → vermietung (hellblau, bestaetigt)
        //   - sonst                    → auftrag    (rot)
        const itemType: ItemType =
          j.status === "entwurf" ? "entwurf"
          : j.was_anfrage ? "vermietung"
          : "auftrag";
        const start = new Date(j.start_date);
        const end = j.end_date ? new Date(j.end_date) : undefined;
        const customerName = j.customer?.name ?? null;
        const locationName = j.location?.name ?? j.room?.name ?? null;
        const title = j.job_number != null ? `INT-${j.job_number} | ${j.title}` : j.title;
        calItems.push({
          id: j.id,
          type: itemType,
          jobNumber: j.job_number,
          title,
          date: start,
          endDate: end,
          customerName,
          locationName,
          href: `/auftraege/${j.id}`,
        });
      }

      const calShifts: CalendarShift[] = [];
      for (const a of (shiftsRes.data ?? []) as unknown as RawShift[]) {
        const job = a.job;
        // Termine eines stornierten Auftrags ueberspringen — Konsistenz mit
        // calItems oben, wo storniert auch raus geht.
        if (job?.status === "storniert") continue;
        // Termine legacy Vermietentwurf-Jobs (status='anfrage') werden
        // ebenfalls ausgeblendet — sonst zeigt der Kalender Punkte, die zu
        // gar nichts mehr fuehren.
        if (job?.status === "anfrage") continue;
        const start = new Date(a.start_time);
        const end = a.end_time ? new Date(a.end_time) : undefined;
        const jobType: CalendarShift["jobType"] = job
          ? job.status === "entwurf" ? "entwurf"
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
          assigneeId: a.assigned_to ?? null,
          href: a.job_id ? `/auftraege/${a.job_id}` : null,
          meetingLink: a.meeting_link ?? null,
        });
      }

      // Projekt-Termine als CalendarShift einreihen (Projekt-Ref statt Job-Ref).
      interface RawProjAppt {
        id: string; title: string; start_time: string; end_time: string | null;
        assigned_to: string | null; assignee: { full_name: string } | null;
        project: { id: string; project_number: number | null; title: string; status: string } | null;
      }
      for (const a of (projApptsRes.data ?? []) as unknown as RawProjAppt[]) {
        const proj = a.project;
        if (!proj) continue;
        if (proj.status === "storniert") continue;
        const start = new Date(a.start_time);
        const end = a.end_time ? new Date(a.end_time) : undefined;
        calShifts.push({
          id: a.id,
          jobId: proj.id,
          jobType: "projekt",
          jobNumber: proj.project_number,
          jobTitle: proj.title,
          date: start,
          endDate: end,
          title: a.title,
          assigneeName: a.assignee?.full_name ?? null,
          assigneeId: a.assigned_to ?? null,
          href: `/projekte/${proj.id}`,
          meetingLink: null,
        });
      }

      const calTimeOffs: CalendarTimeOff[] = [];
      for (const r of (timeOffRes.data ?? []) as unknown as RawTimeOff[]) {
        if (!r.user_id) continue;
        const [sy, sm, sd] = r.start_date.split("-").map(Number);
        const [ey, em, ed] = r.end_date.split("-").map(Number);
        calTimeOffs.push({
          id: r.id,
          userId: r.user_id,
          userName: r.user?.full_name ?? "Unbekannt",
          type: r.type,
          startDate: new Date(sy, sm - 1, sd),
          endDate: new Date(ey, em - 1, ed),
        });
      }

      setItems(calItems);
      setShifts(calShifts);
      setTimeOffs(calTimeOffs);
    } catch (e) {
      logError("kalender.load", e);
    } finally {
      setLoading(false);
    }
  }, [supabase, year, month]);

  useEffect(() => { load(); }, [load]);

  // Nach Termin-Save/-Delete: Kalender-Daten neu laden UND den BVG-Monats-
  // Cache invalidieren — der Forecast rechnet aus den Monats-Terminen, ein
  // gecachter Wert waere nach dem Save bis zum Monatswechsel stale.
  // bvgRefreshKey stoesst den Forecast-Effect fuer den sichtbaren Monat an.
  const handleTerminChanged = useCallback(() => {
    bvgCacheRef.current.clear();
    setBvgRefreshKey((k) => k + 1);
    void load();
  }, [load]);

  // BVG-Forecast pro Person fuer den Monat der aktuell sichtbaren Wochen-
  // Ansicht (Pille im Schichtplan). Eigener Loader weil wir den GANZEN Monat
  // brauchen — nicht nur die Sicht-Woche — sonst stimmt der Forecast nicht.
  // Massgeblicher Monat = Monat des Donnerstags (weekDays[3], ISO-Konvention).
  // Deps sind die primitiven Monats-Werte statt weekDays — Wochen-Nav
  // innerhalb desselben Monats feuert den Effect gar nicht erst neu; ueber
  // Monatsgrenzen hinweg greift zusaetzlich der bvgCacheRef pro Monats-Key.
  const bvgYear = weekDays[3].getFullYear();
  const bvgMonth = weekDays[3].getMonth() + 1;
  useEffect(() => {
    if (view !== "woche") return;
    const cacheKey = `${bvgYear}-${bvgMonth}`;
    const cached = bvgCacheRef.current.get(cacheKey);
    if (cached) {
      setBvgByPerson(cached);
      return;
    }
    let cancelled = false;
    const m = monthRange(bvgYear, bvgMonth);
    (async () => {
      const [thresholdRes, compRes, apptsRes] = await Promise.all([
        supabase.rpc("get_current_bvg_threshold", { p_as_of: m.start }),
        supabase.from("employee_compensation").select("profile_id, hourly_wage_chf, effective_from, effective_to"),
        supabase.from("job_appointments")
          .select("assigned_to, start_time, end_time")
          .gte("start_time", `${m.start}T00:00:00Z`)
          .lt("start_time", `${m.end}T23:59:59Z`)
          .not("assigned_to", "is", null),
      ]);
      if (cancelled) return;
      const threshold = Number(thresholdRes.data ?? 1837.50);
      const today = todayLocalIso();
      type Comp = { profile_id: string; hourly_wage_chf: number; effective_from: string; effective_to: string | null };
      const wagePerProfile = new Map<string, number>();
      for (const c of (compRes.data ?? []) as Comp[]) {
        if (c.effective_from <= today && (!c.effective_to || c.effective_to >= today)) {
          wagePerProfile.set(c.profile_id, Number(c.hourly_wage_chf));
        }
      }
      type Ex = { assigned_to: string; start_time: string; end_time: string | null };
      const apptsByPerson = new Map<string, { start_time: string; end_time: string | null }[]>();
      for (const a of (apptsRes.data ?? []) as Ex[]) {
        if (!apptsByPerson.has(a.assigned_to)) apptsByPerson.set(a.assigned_to, []);
        apptsByPerson.get(a.assigned_to)!.push({ start_time: a.start_time, end_time: a.end_time });
      }
      const result = new Map<string, BvgPersonForecast>();
      for (const [personId, appts] of apptsByPerson) {
        const wage = wagePerProfile.get(personId);
        if (!wage) continue;
        const chf = calculateForecast(appts, wage, m.start, m.end).total_chf;
        result.set(personId, { chf, threshold, status: forecastStatus(chf, threshold) });
      }
      // Nur NICHT-cancelled Ergebnisse cachen — eine cancelled-Antwort kann
      // von VOR einer Termin-Aenderung stammen (handleTerminChanged leert den
      // Cache mid-flight) und wuerde den frisch geleerten Cache re-verstalen.
      bvgCacheRef.current.set(cacheKey, result);
      setBvgByPerson(result);
    })();
    return () => { cancelled = true; };
  }, [supabase, view, bvgYear, bvgMonth, bvgRefreshKey]);

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
        const startStr = weekDays[0].toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "short" });
        const endStr = weekDays[6].toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "short", year: "numeric" });
        return `KW ${weekNo} · ${startStr} – ${endStr}`;
      })()
    : monthLabel;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {fromDashboard && <BackButton fallbackHref="/dashboard" />}
          <h1 className="text-2xl font-bold tracking-tight">Kalender</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* iCal-Feed als Icon-Button + Popover — vorher als Card unten
              (nur sichtbar wenn man scrollte). Rechts vom Header damit
              der Header knapp bleibt und der Abonnier-Flow trotzdem
              einen Klick entfernt ist. */}
          <div className="relative" ref={icalRef}>
            <button
              type="button"
              onClick={() => setIcalOpen((v) => !v)}
              className={`kasten ${icalOpen ? "kasten-active" : "kasten-muted"}`}
              data-tooltip="Kalender abonnieren (iCal-Feed)"
              data-tooltip-align="end"
              aria-expanded={icalOpen}
              aria-haspopup="dialog"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Abonnieren</span>
            </button>
            {icalOpen && (
              <div className="absolute right-0 top-[calc(100%+8px)] z-40 w-[min(92vw,420px)]">
                <IcalFeedBlock
                  title="Mein Kalender abonnieren"
                  description={
                    <>
                      Persönlicher iCal-Feed mit deinen Aufträgen + Terminen. Kopiere die URL und füge sie in Google
                      Calendar / Apple Calendar / Outlook über <span className="font-medium">&quot;Per URL hinzufügen&quot;</span> ein.
                    </>
                  }
                />
              </div>
            )}
          </div>
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
        <CardContent className="p-3 space-y-3">
          {/* Top-Bar: Range-Label links + Legende/Navigation/View-Toggle rechts */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-lg font-bold capitalize">{rangeLabel}</h2>
            <div className="flex items-center gap-3">
              {/* Legende — status='entwurf' ist Legacy, neue Entwuerfe leben in /entwuerfe. */}
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
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  Projekt
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
              {/* View-Toggle — Default auf Mobile = "woche" (Monatsgrid ist
                  unter 768px kaum bedienbar), Toggle aber trotzdem sichtbar
                  damit Nutzer bei Rotation/Zoom manuell zurueck koennen. */}
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
              timeOffs={timeOffs}
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
                  timeOffs={timeOffs}
                  onStandaloneShiftClick={setEditTerminId}
                  bvgByPerson={bvgByPerson}
                />
              </div>
            </div>
          )}

        </CardContent>
      </Card>

      {/* Lazy-Chunks: erst beim Oeffnen gemountet (siehe dynamic-Imports
          oben) — geschlossen liegt kein Modal-Code im Kalender-Chunk. */}
      {showNeuerTermin && (
        <NeuerTerminModal
          open
          onClose={() => setShowNeuerTermin(false)}
          onCreated={handleTerminChanged}
          // In Monatsansicht: ausgewaehlter Tag wird vorausgefuellt damit der
          // User nicht nochmal das Datum tippen muss.
          initialDate={view === "monat" && selectedDay != null ? new Date(year, month, selectedDay) : null}
        />
      )}

      {editTerminId !== null && (
        <TerminEditModal
          apptId={editTerminId}
          onClose={() => setEditTerminId(null)}
          onChanged={handleTerminChanged}
        />
      )}
    </div>
  );
}
