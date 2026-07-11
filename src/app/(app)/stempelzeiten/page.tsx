"use client";

/**
 * Stempelzeiten-Portal
 *
 * Sichten:
 *  - Eigene Sicht (default): Liste der eigenen Stempel-Eintraege.
 *  - Admin-Sicht: Toggle "Alle Mitarbeiter" laedt via SECURITY-DEFINER-RPC
 *    alle Eintraege quer durchs Team — fuer Lohnabrechnung / Stundenkontrolle.
 *
 * Views (Tabs):
 *  - Liste: nach Tag gruppiert mit Tages-Total, Anomalien-Marker
 *  - Heatmap: Kalender-Grid Monatsansicht, Farbintensitaet = Stunden/Tag
 *  - Pivot: Matrix Job-Zeile x Tag-Spalte mit Stunden je Zelle
 *
 * KPIs: Heute / Diese Woche / Dieser Monat / Avg pro Tag (Monat).
 *
 * Filter: Quick-Chips (Heute/Woche/Monat...), Datum-Range, User (Admin),
 * Anomalien-Only.
 *
 * Anomalien:
 *  - Lange Schicht (>10h)
 *  - Mitternacht-Uebergang (clock_in.date != clock_out.date)
 *  - Vergessen (kein clock_out, > 18h alt)
 *
 * DST-Safety: Tages-Buckets via per-Minute-Bucketize (Europe/Zurich).
 * Wichtig fuer Heatmap + Pivot — eine Schicht 22-04 zaehlt richtig
 * auf zwei Tage verteilt.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
import {
  Briefcase, FileText, Clock, Calendar, User, Trash2,
  AlertTriangle, Moon, LayoutList, LayoutGrid, Table2, Archive,
} from "lucide-react";
import { useStempel, formatStempelDuration } from "@/lib/use-stempel";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { NewTicketModal } from "@/components/tickets/new-ticket-modal";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import {
  ZRH_TZ, localDateIso, todayLocalIso, weekdayForDateIso,
} from "@/lib/swiss-time";
import Link from "next/link";

interface AdminEntry {
  id: string;
  user_id: string;
  user_name: string;
  job_id: string | null;
  job_number: number | null;
  job_title: string | null;
  clock_in: string;
  clock_out: string | null;
  description: string | null;
  notes: string | null;
  duration_minutes: number | null;
}

interface OwnEntry {
  id: string;
  job_id: string | null;
  clock_in: string;
  clock_out: string | null;
  description: string | null;
  notes: string | null;
  job: { job_number: number; title: string } | null;
}

interface NormalizedEntry {
  id: string;
  userName: string | null;
  jobId: string | null;
  jobLabel: string | null;
  jobHref: string | null;
  description: string | null;
  clockIn: string;
  clockOut: string | null;
  durationMinutes: number | null;
}

type ViewMode = "list" | "calendar" | "pivot";
type QuickFilter = "none" | "today" | "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth";

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function formatDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatHours(minutes: number): string {
  if (minutes <= 0) return "0h";
  const h = minutes / 60;
  return h >= 10 ? `${h.toFixed(0)}h` : `${h.toFixed(1)}h`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: ZRH_TZ,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("de-CH", {
    timeZone: ZRH_TZ, weekday: "long", day: "2-digit", month: "long", year: "numeric",
  });
}

/** ISO-Wochen-Start: Montag der Woche fuer ein YYYY-MM-DD. */
function isoWeekStart(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const wd = date.getUTCDay(); // 0=Sun
  const mondayOffset = wd === 0 ? -6 : 1 - wd;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function monthFirstIso(iso: string): string {
  const [y, m] = iso.split("-");
  return `${y}-${m}-01`;
}
function monthLastIso(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return `${y}-${pad2(m)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

function quickFilterRange(qf: QuickFilter): { from: string; to: string } | null {
  if (qf === "none") return null;
  const today = todayLocalIso();
  if (qf === "today") return { from: today, to: today };
  if (qf === "thisWeek") {
    const start = isoWeekStart(today);
    return { from: start, to: addDaysIso(start, 6) };
  }
  if (qf === "lastWeek") {
    const start = addDaysIso(isoWeekStart(today), -7);
    return { from: start, to: addDaysIso(start, 6) };
  }
  if (qf === "thisMonth") {
    return { from: monthFirstIso(today), to: monthLastIso(today) };
  }
  // lastMonth
  const firstOfThis = monthFirstIso(today);
  const lastOfLast = addDaysIso(firstOfThis, -1);
  return { from: monthFirstIso(lastOfLast), to: lastOfLast };
}

function normalizeAdmin(e: AdminEntry): NormalizedEntry {
  return {
    id: e.id,
    userName: e.user_name,
    jobId: e.job_id,
    jobLabel: e.job_id && e.job_number ? `INT-${e.job_number} · ${e.job_title}` : null,
    jobHref: e.job_id ? `/auftraege/${e.job_id}` : null,
    description: e.description,
    clockIn: e.clock_in,
    clockOut: e.clock_out,
    durationMinutes: e.duration_minutes,
  };
}

function normalizeOwn(e: OwnEntry): NormalizedEntry {
  const dur = e.clock_out
    ? Math.max(0, Math.floor((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000))
    : null;
  return {
    id: e.id,
    userName: null,
    jobId: e.job_id,
    jobLabel: e.job_id && e.job ? `INT-${e.job.job_number} · ${e.job.title}` : null,
    jobHref: e.job_id ? `/auftraege/${e.job_id}` : null,
    description: e.description,
    clockIn: e.clock_in,
    clockOut: e.clock_out,
    durationMinutes: dur,
  };
}

interface Anomaly {
  longShift: boolean;
  crossesMidnight: boolean;
  forgotten: boolean;
}
function detectAnomaly(e: NormalizedEntry, nowMs: number): Anomaly {
  const longShift = e.durationMinutes !== null && e.durationMinutes > 10 * 60;
  const crossesMidnight = !!e.clockOut && localDateIso(new Date(e.clockIn)) !== localDateIso(new Date(e.clockOut));
  const forgotten = !e.clockOut && (nowMs - new Date(e.clockIn).getTime()) > 18 * 60 * 60 * 1000;
  return { longShift, crossesMidnight, forgotten };
}
function hasAnomaly(a: Anomaly): boolean { return a.longShift || a.forgotten; }

/** 1-2 Initialen aus einem Namen ("Mathis Berger" -> "MB"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stabile HSL-Farbe pro Name (gleicher Name -> gleiche Farbe). */
function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}

interface DayBucket {
  date: string;
  totalMin: number;
  byJob: Map<string, number>; // jobLabel ("INT-123 · Title") oder "Andere"
}

/** Verteilt eine Liste Eintraege per-Minute auf Lokal-Datums-Buckets.
 *  Splittet auch Mitternacht-Uebergaenge korrekt. */
function buildDayBuckets(entries: NormalizedEntry[]): Map<string, DayBucket> {
  const out = new Map<string, DayBucket>();
  for (const e of entries) {
    if (!e.clockOut) continue;
    const start = new Date(e.clockIn).getTime();
    const end = new Date(e.clockOut).getTime();
    if (end <= start) continue;
    const label = e.jobLabel ?? "Andere Arbeit";
    // Verwende bucketizeMinutes fuer total — fuer Job-Aufschluesselung
    // einfach selbst splitten (gleiche per-Minute-Logik).
    for (let t = start; t < end; t += 60_000) {
      const date = localDateIso(new Date(t));
      let b = out.get(date);
      if (!b) {
        b = { date, totalMin: 0, byJob: new Map() };
        out.set(date, b);
      }
      b.totalMin++;
      b.byJob.set(label, (b.byJob.get(label) ?? 0) + 1);
    }
  }
  return out;
}

export default function StempelzeitenPage() {
  const supabase = createClient();
  const { active } = useStempel();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showStempelTicket, setShowStempelTicket] = useState(false);
  const { can } = usePermissions();
  const [ownEntries, setOwnEntries] = useState<OwnEntry[]>([]);
  const [adminEntries, setAdminEntries] = useState<AdminEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterUserId, setFilterUserId] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("none");
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  // Archiv-Cutoff: standardmaessig blenden wir Eintraege aus die aelter
  // als 30 Tage sind (aus der Hauptansicht 'archiviert'). Wird bei jedem
  // manuellen Datums-Filter oder QuickFilter ausser lastWeek/lastMonth
  // deaktiviert damit der User dann trotzdem alles im gewaehlten Zeitraum
  // sieht. 'Archiv anzeigen'-Chip flippt den Wert manuell.
  const [showArchive, setShowArchive] = useState(false);
  const [view, setView] = useState<ViewMode>("list");
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setCurrentUserId(user.id);
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      setIsAdmin(profile?.role === "admin");
    })();
  }, [supabase]);

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      const { data } = await supabase.rpc("get_assignable_users");
      setUsers((data as { id: string; full_name: string }[]) ?? []);
    })();
  }, [isAdmin, supabase]);

  // Quick-Filter setzt Datum-Range. Manuelle Aenderungen am Datum reseten
  // Quick-Filter implizit (visual). Bei "none" werden Daten NICHT geleert.
  useEffect(() => {
    const r = quickFilterRange(quickFilter);
    if (r) {
      setFilterFrom(r.from);
      setFilterTo(r.to);
    }
  }, [quickFilter]);

  // Effektiver 'from' fuer die Query — beruecksichtigt Archiv-Cutoff.
  // Wenn User keinen filter_from gesetzt hat UND showArchive=false, greift
  // der 30-Tage-Cutoff (heute - 30d). Sobald User explizit ein Datum waehlt,
  // hat seins Vorrang. Bei showArchive=true kein Cutoff (auch >30d).
  const effectiveFilterFrom = useMemo(() => {
    if (filterFrom) return filterFrom;
    if (showArchive) return "";
    return addDaysIso(todayLocalIso(), -30);
  }, [filterFrom, showArchive]);

  const load = useCallback(async () => {
    setLoading(true);
    const fromIso = effectiveFilterFrom
      ? new Date(effectiveFilterFrom + "T00:00:00").toISOString()
      : null;
    if (showAll && isAdmin) {
      const { data, error } = await supabase.rpc("get_all_time_entries", {
        filter_user_id: filterUserId || null,
        filter_from: fromIso,
        filter_to: filterTo ? new Date(filterTo + "T23:59:59").toISOString() : null,
      });
      if (error) TOAST.supabaseError(error, "Stempel-Eintraege konnten nicht geladen werden");
      setAdminEntries((data as AdminEntry[]) ?? []);
    } else {
      // RLS-Bug-Schutz: Admins haetten via RLS-Policy Zugriff auf ALLE
      // time_entries — ohne expliziten user_id-Filter zeigt "Eigene Sicht"
      // auch fremde Eintraege. Daher hier zwingend nach currentUserId
      // filtern. Wenn currentUserId noch nicht geladen, kein Query (load
      // wird re-triggered sobald gesetzt).
      if (!currentUserId) { setLoading(false); return; }
      let q = supabase
        .from("time_entries")
        .select("id, job_id, clock_in, clock_out, description, notes, job:jobs(job_number, title)")
        .eq("user_id", currentUserId)
        .order("clock_in", { ascending: false });
      if (fromIso) q = q.gte("clock_in", fromIso);
      if (filterTo) q = q.lt("clock_in", new Date(filterTo + "T23:59:59").toISOString());
      const { data } = await q;
      setOwnEntries((data as unknown as OwnEntry[]) ?? []);
    }
    setLoading(false);
  }, [supabase, showAll, isAdmin, currentUserId, filterUserId, effectiveFilterFrom, filterTo]);

  useEffect(() => { load(); }, [load]);

  async function deleteEntry(id: string) {
    const ok = await confirm({
      title: "Eintrag löschen?",
      message: "Der Stempel-Eintrag wird unwiderruflich entfernt.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("time_entries").delete().eq("id", id);
    if (error) {
      TOAST.supabaseError(error, "Eintrag konnte nicht gelöscht werden");
      return;
    }
    toast.success("Eintrag gelöscht");
    load();
  }

  // Normalisierte Eintragsliste (eine Schicht — gleiche Shape egal ob own/admin).
  const normalized: NormalizedEntry[] = useMemo(() => {
    if (showAll && isAdmin) return adminEntries.map(normalizeAdmin);
    return ownEntries.map(normalizeOwn);
  }, [showAll, isAdmin, adminEntries, ownEntries]);

  const filtered = useMemo(() => {
    if (!anomaliesOnly) return normalized;
    return normalized.filter((e) => hasAnomaly(detectAnomaly(e, now)));
  }, [normalized, anomaliesOnly, now]);

  // Tages-Buckets (DST-safe, Mitternacht-Splits korrekt).
  const dayBuckets = useMemo(() => buildDayBuckets(normalized), [normalized]);

  // KPI: Heute / Diese Woche / Dieser Monat / Avg pro Tag im Monat.
  // Berechnung gegen die GESAMTE geladene Datenmenge (nicht das Anomalien-
  // Filter) damit die Zahlen stabil bleiben.
  const kpi = useMemo(() => {
    const today = todayLocalIso();
    const weekStart = isoWeekStart(today);
    const monthFirst = monthFirstIso(today);
    const monthLast = monthLastIso(today);
    let todayMin = 0, weekMin = 0, monthMin = 0;
    const daysWithEntries = new Set<string>();
    for (const [date, b] of dayBuckets) {
      if (date === today) todayMin += b.totalMin;
      if (date >= weekStart && date <= addDaysIso(weekStart, 6)) weekMin += b.totalMin;
      if (date >= monthFirst && date <= monthLast) {
        monthMin += b.totalMin;
        daysWithEntries.add(date);
      }
    }
    const avgPerDay = daysWithEntries.size > 0 ? Math.round(monthMin / daysWithEntries.size) : 0;
    return { todayMin, weekMin, monthMin, avgPerDay, daysWorked: daysWithEntries.size };
  }, [dayBuckets]);

  // Total fuer aktuelle Filter-Auswahl (zeigt Range-Total).
  const filteredTotalMin = useMemo(() => {
    return filtered.reduce((sum, e) => sum + (e.durationMinutes ?? 0), 0);
  }, [filtered]);

  // Anomalien-Count fuer Chip-Badge.
  const anomalyCount = useMemo(
    () => normalized.filter((e) => hasAnomaly(detectAnomaly(e, now))).length,
    [normalized, now],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 min-h-9">
        <div className="flex items-center gap-4">
          <BackButton fallbackHref="/hr" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Stempelzeiten</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {showAll && isAdmin ? "Alle Mitarbeiter" : "Deine Einträge"} ·{" "}
              <span className="font-semibold">Range: {formatDuration(filteredTotalMin)}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {can("tickets:create") && (
            <button
              type="button"
              onClick={() => setShowStempelTicket(true)}
              className="kasten kasten-green"
              data-tooltip="Stempel-Aenderung anfragen"
            >
              <Clock className="h-3.5 w-3.5" />
              Stempel-Änderung
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className={showAll ? "kasten-active" : "kasten-toggle-off"}
            >
              <User className="h-3.5 w-3.5" />
              {showAll ? "Eigene Sicht" : "Alle Mitarbeiter"}
            </button>
          )}
        </div>
      </div>

      {/* Aktiver Eintrag-Banner */}
      {active && (
        <Card className="bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30">
          <CardContent className="p-4 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
              </span>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-green-700 dark:text-green-400">Aktuell eingestempelt</p>
                <p className="text-sm font-medium">
                  {active.job_id ? "Auf einem Auftrag" : (active.description || "Andere Arbeit")}
                </p>
              </div>
            </div>
            <span className="font-mono text-lg font-semibold tabular-nums text-green-700 dark:text-green-400">
              {formatStempelDuration(active.clock_in, now)}
            </span>
          </CardContent>
        </Card>
      )}

      {/* KPI-Header */}
      <KpiHeader kpi={kpi} />

      {/* Quick-Filter-Chips + Anomalien-Chip */}
      <QuickChips
        quick={quickFilter}
        onPick={setQuickFilter}
        anomaliesOnly={anomaliesOnly}
        onAnomaliesToggle={() => setAnomaliesOnly((v) => !v)}
        anomalyCount={anomalyCount}
      />

      {/* Datum/User-Filter */}
      <div className="flex flex-col sm:flex-row gap-2 flex-wrap items-end">
        <div className="flex gap-2 items-center">
          <label className="text-xs text-muted-foreground">Von</label>
          <Input
            type="date"
            value={filterFrom}
            onChange={(e) => { setFilterFrom(e.target.value); setQuickFilter("none"); }}
            placeholder={showArchive || filterFrom ? "" : effectiveFilterFrom}
            className="h-9 w-40"
            data-tooltip={!filterFrom && !showArchive ? `Standard-Cutoff: ${effectiveFilterFrom} (letzte 30 Tage)` : undefined}
          />
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-xs text-muted-foreground">Bis</label>
          <Input type="date" value={filterTo} onChange={(e) => { setFilterTo(e.target.value); setQuickFilter("none"); }} className="h-9 w-40" />
        </div>
        {showAll && isAdmin && (
          <div className="w-full sm:w-48">
            <SearchableSelect
              value={filterUserId}
              onChange={setFilterUserId}
              items={[
                { id: "", label: "Alle Mitarbeiter" },
                ...users.map((u) => ({ id: u.id, label: u.full_name })),
              ]}
              searchable={false}
              clearable={false}
              active={!!filterUserId}
            />
          </div>
        )}
        {/* Archiv-Toggle — steuert den 30-Tage-Cutoff. Ohne expliziten
            Datums-Filter zeigt die Ansicht nur die letzten 30 Tage; dieser
            Chip macht den Rest sichtbar. */}
        <button
          type="button"
          onClick={() => setShowArchive((v) => !v)}
          className={`h-9 px-3 text-xs rounded-lg flex items-center gap-1.5 transition-colors border ${
            showArchive
              ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04]"
          }`}
          data-tooltip={showArchive
            ? "Auch Eintraege aelter als 30 Tage werden geladen"
            : "Standard: nur die letzten 30 Tage sichtbar"}
        >
          <Archive className="h-3.5 w-3.5" />
          {showArchive ? "Archiv aktiv" : "Archiv"}
        </button>
        {(filterFrom || filterTo || filterUserId || quickFilter !== "none" || anomaliesOnly || showArchive) && (
          <button
            type="button"
            onClick={() => {
              setFilterFrom(""); setFilterTo(""); setFilterUserId("");
              setQuickFilter("none"); setAnomaliesOnly(false); setShowArchive(false);
            }}
            className="h-9 px-3 text-xs text-muted-foreground hover:text-foreground rounded-lg flex items-center gap-1.5 transition-colors"
          >
            Reset
          </button>
        )}

        {/* View-Toggle (rechts) */}
        <div className="sm:ml-auto flex gap-1 p-1 rounded-lg bg-muted">
          <ViewBtn icon={LayoutList} label="Liste" active={view === "list"} onClick={() => setView("list")} />
          <ViewBtn icon={LayoutGrid} label="Heatmap" active={view === "calendar"} onClick={() => setView("calendar")} />
          <ViewBtn icon={Table2} label="Pivot" active={view === "pivot"} onClick={() => setView("pivot")} />
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-4 h-16" /></Card>)}</div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <Clock className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-lg">Keine Einträge</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {anomaliesOnly
                ? "Keine Auffaelligkeiten im gewaehlten Zeitraum."
                : (showAll && isAdmin ? "Im gewählten Zeitraum hat niemand gestempelt." : "Du hast noch keine Stempel-Einträge.")}
            </p>
          </CardContent>
        </Card>
      ) : view === "list" ? (
        <GroupedList entries={filtered} now={now} onDelete={deleteEntry} />
      ) : view === "calendar" ? (
        <CalendarHeatmap dayBuckets={dayBuckets} anchor={filterFrom || filterTo || todayLocalIso()} />
      ) : (
        <PivotTable dayBuckets={dayBuckets} from={filterFrom} to={filterTo} />
      )}

      {ConfirmModalElement}

      <NewTicketModal
        open={showStempelTicket}
        onClose={() => setShowStempelTicket(false)}
        onCreated={() => {
          setShowStempelTicket(false);
          toast.success("Ticket erstellt — Admin wurde benachrichtigt");
        }}
        initialType="stempel_aenderung"
      />
    </div>
  );
}

// ------------------ KPI-Header ------------------

interface KpiData {
  todayMin: number;
  weekMin: number;
  monthMin: number;
  avgPerDay: number;
  daysWorked: number;
}
function KpiHeader({ kpi }: { kpi: KpiData }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <KpiCard label="Heute" value={formatDuration(kpi.todayMin)} />
      <KpiCard label="Diese Woche" value={formatDuration(kpi.weekMin)} />
      <KpiCard label="Dieser Monat" value={formatDuration(kpi.monthMin)} sub={`${kpi.daysWorked} ${kpi.daysWorked === 1 ? "Tag" : "Tage"}`} />
      <KpiCard label="Ø pro Arbeitstag" value={formatDuration(kpi.avgPerDay)} sub="im aktuellen Monat" />
    </div>
  );
}
function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="bg-card">
      <CardContent className="p-3">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</p>
        <p className="text-xl font-bold tabular-nums mt-0.5">{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ------------------ Quick-Chips ------------------

function QuickChips({
  quick, onPick, anomaliesOnly, onAnomaliesToggle, anomalyCount,
}: {
  quick: QuickFilter;
  onPick: (q: QuickFilter) => void;
  anomaliesOnly: boolean;
  onAnomaliesToggle: () => void;
  anomalyCount: number;
}) {
  const chips: { key: QuickFilter; label: string }[] = [
    { key: "today", label: "Heute" },
    { key: "thisWeek", label: "Diese Woche" },
    { key: "lastWeek", label: "Letzte Woche" },
    { key: "thisMonth", label: "Dieser Monat" },
    { key: "lastMonth", label: "Letzter Monat" },
  ];
  return (
    <div className="flex gap-2 flex-wrap">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onPick(quick === c.key ? "none" : c.key)}
          className={quick === c.key ? "kasten-active" : "kasten-toggle-off"}
        >
          {c.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onAnomaliesToggle}
        className={anomaliesOnly ? "kasten kasten-red" : "kasten-toggle-off"}
        data-tooltip="Lange Schichten + vergessene Stempel"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        Auffaellig
        {anomalyCount > 0 && (
          <span className="ml-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-red-500/20 text-red-600 dark:text-red-400">
            {anomalyCount}
          </span>
        )}
      </button>
    </div>
  );
}

function ViewBtn({ icon: Icon, label, active, onClick }: { icon: typeof Clock; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-7 px-2.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
        active ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
      data-tooltip={label}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

// ------------------ Grouped List ------------------

function GroupedList({
  entries, now, onDelete,
}: {
  entries: NormalizedEntry[];
  now: number;
  onDelete: (id: string) => void;
}) {
  // Gruppieren nach clock_in.localDate. Sortiert: neueste Tage zuerst.
  const groups = useMemo(() => {
    const map = new Map<string, NormalizedEntry[]>();
    for (const e of entries) {
      const d = localDateIso(new Date(e.clockIn));
      const arr = map.get(d) ?? [];
      arr.push(e);
      map.set(d, arr);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries]);

  return (
    <div className="space-y-4">
      {groups.map(([date, list]) => {
        const total = list.reduce((s, e) => s + (e.durationMinutes ?? 0), 0);
        const wd = weekdayForDateIso(date);
        const isWeekend = wd === 0 || wd === 6;
        return (
          <div key={date}>
            <div className={`flex items-center justify-between gap-2 mb-2 sticky top-0 z-10 bg-background/95 backdrop-blur py-1 border-b ${isWeekend ? "border-amber-200 dark:border-amber-500/30" : "border-border"}`}>
              <div className="flex items-center gap-2">
                <Calendar className={`h-3.5 w-3.5 ${isWeekend ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`} />
                <span className="text-xs font-semibold uppercase tracking-wider">{formatLongDate(date)}</span>
                {isWeekend && <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">Wochenende</span>}
              </div>
              <span className="text-xs font-bold tabular-nums">{formatDuration(total)}</span>
            </div>
            <div className="space-y-2">
              {list.map((e) => (
                <EntryCard key={e.id} entry={e} anomaly={detectAnomaly(e, now)} onDelete={() => onDelete(e.id)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------ Calendar Heatmap ------------------

function CalendarHeatmap({ dayBuckets, anchor }: { dayBuckets: Map<string, DayBucket>; anchor: string }) {
  // Monat = anchor's Monat
  const [year, month] = anchor.split("-").map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1, 12));
  const daysInMonth = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();

  // Mo=0, So=6 (ISO-Woche)
  const firstWd = (firstDay.getUTCDay() + 6) % 7;
  const cells: Array<{ date: string | null; min: number }> = [];
  for (let i = 0; i < firstWd; i++) cells.push({ date: null, min: 0 });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${pad2(month)}-${pad2(d)}`;
    cells.push({ date: iso, min: dayBuckets.get(iso)?.totalMin ?? 0 });
  }
  // Auf volle Wochen auffuellen
  while (cells.length % 7 !== 0) cells.push({ date: null, min: 0 });

  const maxMin = cells.reduce((m, c) => Math.max(m, c.min), 0);
  const today = todayLocalIso();

  function bgFor(min: number): string {
    if (min === 0) return "bg-muted/40";
    const ratio = maxMin > 0 ? min / maxMin : 0;
    if (ratio < 0.25) return "bg-red-200 dark:bg-red-500/25";
    if (ratio < 0.5) return "bg-red-300 dark:bg-red-500/45";
    if (ratio < 0.75) return "bg-red-400 dark:bg-red-500/65";
    return "bg-red-500 dark:bg-red-500/85";
  }

  const monthLabel = firstDay.toLocaleDateString("de-CH", { timeZone: ZRH_TZ, month: "long", year: "numeric" });
  const monthTotal = cells.reduce((s, c) => s + c.min, 0);

  return (
    <Card className="bg-card">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm">{monthLabel}</h3>
            <p className="text-xs text-muted-foreground">Farbintensitaet = Stunden pro Tag</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Monats-Total</p>
            <p className="text-lg font-bold tabular-nums">{formatDuration(monthTotal)}</p>
          </div>
        </div>

        {/* Weekday-Header */}
        <div className="grid grid-cols-7 gap-1 text-[10px] font-semibold text-muted-foreground mb-1">
          {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((w, i) => (
            <div key={w} className={`text-center ${i >= 5 ? "text-amber-600 dark:text-amber-400" : ""}`}>{w}</div>
          ))}
        </div>

        {/* Cells */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((c, i) => {
            if (!c.date) return <div key={`empty-${i}`} className="aspect-square" />;
            const day = c.date.slice(8);
            const isToday = c.date === today;
            return (
              <div
                key={c.date}
                className={`aspect-square rounded-md flex flex-col items-center justify-center p-1 ${bgFor(c.min)} ${isToday ? "ring-2 ring-foreground" : ""}`}
                data-tooltip={c.min > 0 ? `${formatLongDate(c.date)}: ${formatDuration(c.min)}` : formatLongDate(c.date)}
              >
                <span className="text-[10px] font-semibold leading-tight">{Number(day)}</span>
                {c.min > 0 && <span className="text-[9px] tabular-nums leading-tight opacity-80">{formatHours(c.min)}</span>}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-end gap-1 mt-3 text-[10px] text-muted-foreground">
          <span>Wenig</span>
          <span className="w-3 h-3 rounded-sm bg-red-200 dark:bg-red-500/25" />
          <span className="w-3 h-3 rounded-sm bg-red-300 dark:bg-red-500/45" />
          <span className="w-3 h-3 rounded-sm bg-red-400 dark:bg-red-500/65" />
          <span className="w-3 h-3 rounded-sm bg-red-500 dark:bg-red-500/85" />
          <span>Viel</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------ Pivot Job x Tag ------------------

function PivotTable({
  dayBuckets, from, to,
}: {
  dayBuckets: Map<string, DayBucket>;
  from: string;
  to: string;
}) {
  // Datums-Range bestimmen: aus filter oder aus den Daten
  const dates = useMemo(() => {
    const dates = Array.from(dayBuckets.keys()).sort();
    if (dates.length === 0) return [];
    const min = from || dates[0];
    const max = to || dates[dates.length - 1];
    const out: string[] = [];
    let cur = min;
    let safety = 0;
    while (cur <= max && safety < 400) {
      out.push(cur);
      cur = addDaysIso(cur, 1);
      safety++;
    }
    return out;
  }, [dayBuckets, from, to]);

  // Jobs zusammensammeln
  const jobs = useMemo(() => {
    const set = new Set<string>();
    for (const b of dayBuckets.values()) for (const j of b.byJob.keys()) set.add(j);
    return Array.from(set).sort();
  }, [dayBuckets]);

  if (jobs.length === 0 || dates.length === 0) {
    return (
      <Card className="bg-card border-dashed">
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          Keine Daten fuer die Pivot-Ansicht.
        </CardContent>
      </Card>
    );
  }

  const rowTotals = new Map<string, number>();
  const colTotals = new Map<string, number>();
  let grand = 0;
  for (const j of jobs) {
    let row = 0;
    for (const d of dates) {
      const v = dayBuckets.get(d)?.byJob.get(j) ?? 0;
      row += v;
      colTotals.set(d, (colTotals.get(d) ?? 0) + v);
    }
    rowTotals.set(j, row);
    grand += row;
  }

  return (
    <Card className="bg-card">
      <CardContent className="p-0 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card border-b">
            <tr>
              <th className="text-left px-3 py-2 font-semibold sticky left-0 bg-card z-10 min-w-[200px]">Auftrag</th>
              {dates.map((d) => {
                const wd = weekdayForDateIso(d);
                const we = wd === 0 || wd === 6;
                return (
                  <th key={d} className={`text-right px-2 py-2 font-semibold whitespace-nowrap ${we ? "text-amber-600 dark:text-amber-400" : ""}`}>
                    {d.slice(8)}.{d.slice(5, 7)}
                  </th>
                );
              })}
              <th className="text-right px-3 py-2 font-bold sticky right-0 bg-card border-l">Total</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j} className="border-b last:border-b-0 hover:bg-muted/30">
                <td className="px-3 py-1.5 sticky left-0 bg-card hover:bg-muted/30 truncate max-w-[260px]" title={j}>{j}</td>
                {dates.map((d) => {
                  const v = dayBuckets.get(d)?.byJob.get(j) ?? 0;
                  return (
                    <td key={d} className={`text-right px-2 py-1.5 tabular-nums ${v === 0 ? "text-muted-foreground/30" : ""}`}>
                      {v > 0 ? formatHours(v) : "·"}
                    </td>
                  );
                })}
                <td className="text-right px-3 py-1.5 tabular-nums font-bold sticky right-0 bg-card border-l">{formatDuration(rowTotals.get(j) ?? 0)}</td>
              </tr>
            ))}
            <tr className="border-t-2 bg-muted/40 font-semibold">
              <td className="px-3 py-2 sticky left-0 bg-muted/40">Total</td>
              {dates.map((d) => (
                <td key={d} className="text-right px-2 py-2 tabular-nums">
                  {(colTotals.get(d) ?? 0) > 0 ? formatHours(colTotals.get(d) ?? 0) : "·"}
                </td>
              ))}
              <td className="text-right px-3 py-2 tabular-nums sticky right-0 bg-muted/40 border-l">{formatDuration(grand)}</td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// ------------------ Entry-Card (mit Anomalien-Markern) ------------------

function EntryCard({
  entry, anomaly, onDelete,
}: {
  entry: NormalizedEntry;
  anomaly: Anomaly;
  onDelete: () => void;
}) {
  const isRunning = !entry.clockOut;
  const flagged = hasAnomaly(anomaly);
  const borderClass = flagged
    ? "border-amber-300 dark:border-amber-500/40"
    : isRunning
      ? "border-green-300 dark:border-green-500/40"
      : "";
  return (
    <Card className={`card-hover bg-card ${borderClass}`}>
      <CardContent className="p-4 flex items-center gap-3 flex-wrap">
        {entry.userName ? (
          // Admin-View: Initialen-Avatar links damit man auf einen Blick
          // sieht WER gestempelt hat. Job-Type wird kleines Inline-Icon
          // neben dem Job-Label.
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold text-white"
            style={{ backgroundColor: colorForName(entry.userName) }}
            data-tooltip={entry.userName}
          >
            {initials(entry.userName)}
          </div>
        ) : (
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
            entry.jobLabel ? "bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400"
                           : "bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400"
          }`}>
            {entry.jobLabel ? <Briefcase className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
          </div>
        )}
        <div className="flex-1 min-w-0">
          {entry.userName && (
            <p className="text-sm font-bold leading-tight" style={{ color: colorForName(entry.userName) }}>
              {entry.userName}
            </p>
          )}
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            {entry.userName && (
              entry.jobLabel
                ? <Briefcase className="h-3 w-3 text-red-600 dark:text-red-400 shrink-0" />
                : <FileText className="h-3 w-3 text-amber-600 dark:text-amber-400 shrink-0" />
            )}
            {entry.jobLabel ? (
              entry.jobHref ? (
                <Link href={entry.jobHref} className="font-medium text-sm hover:underline truncate">{entry.jobLabel}</Link>
              ) : (
                <span className="font-medium text-sm truncate">{entry.jobLabel}</span>
              )
            ) : (
              <span className="font-medium text-sm truncate">{entry.description || "Andere Arbeit"}</span>
            )}
            {isRunning && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                </span>
                Läuft
              </span>
            )}
            {anomaly.longShift && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                data-tooltip="Schicht ueber 10 Stunden"
              >
                <AlertTriangle className="h-2.5 w-2.5" /> Lang
              </span>
            )}
            {anomaly.crossesMidnight && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300"
                data-tooltip="Geht ueber Mitternacht"
              >
                <Moon className="h-2.5 w-2.5" /> Nacht
              </span>
            )}
            {anomaly.forgotten && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                data-tooltip="Kein Stempel-Out seit >18h — vermutlich vergessen"
              >
                <AlertTriangle className="h-2.5 w-2.5" /> Vergessen?
              </span>
            )}
          </div>
          {entry.jobLabel && entry.description && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{entry.description}</p>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
            <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{formatDateTime(entry.clockIn)}</span>
            {entry.clockOut && <span>→ {formatDateTime(entry.clockOut)}</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="font-mono font-semibold text-sm tabular-nums">
            {entry.durationMinutes !== null ? formatDuration(entry.durationMinutes) : "läuft…"}
          </p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors shrink-0"
          aria-label="Eintrag löschen"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </CardContent>
    </Card>
  );
}

