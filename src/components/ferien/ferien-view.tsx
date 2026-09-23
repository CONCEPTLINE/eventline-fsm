"use client";

/**
 * Ferien & Abwesenheit — Mitarbeiter beantragen, Admin genehmigt.
 *
 * Struktur (2026-09-06 vereinfacht nach Leo-Feedback "keine Ordnung, sieht
 * auch vergangene, zu viele komische infos"):
 *
 *   Section 1 — "Zu genehmigen"       (nur Admin, nur wenn offen)
 *   Section 2 — "Aktuell & Kommend"   (start_date ASC = naechstes zuerst)
 *   Section 3 — "Vergangen"           (collapsed by default, DESC)
 *
 * Keine Status- oder Typ-Filter mehr — die Sektionen ersetzen den
 * Status-Filter, und die Typ-Icons in jeder Row machen visuelles Scannen
 * nach Typ ausreichend. Fuer Admin bleibt nur der Meine/Team-Toggle.
 *
 * Vergangenes ist kollabiert, damit die Hauptansicht nicht durch Historie
 * ueberladen wird — der User klickt einmal um sie zu sehen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Plane,
  ThermometerSun,
  Repeat,
  Coffee,
  Shield,
  Plus,
  Check,
  X,
  Trash2,
  Calendar,
  AlertCircle,
  Inbox,
  UserRound,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import { useConfirm } from "@/components/ui/use-confirm";
import type { TimeOff, TimeOffType, TimeOffStatus } from "@/types";
import { useSearchParams, usePathname } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";

interface TimeOffWithUser extends TimeOff {
  user: { full_name: string } | null;
}

const TYPE_META: Record<TimeOffType, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  ferien:        { label: "Ferien",         icon: Plane,           color: "bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200" },
  krank:         { label: "Krank",          icon: ThermometerSun,  color: "bg-red-100 text-red-700 dark:bg-red-500/25 dark:text-red-200" },
  kompensation:  { label: "Kompensation",   icon: Repeat,          color: "bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-amber-200" },
  frei:          { label: "Frei",           icon: Coffee,          color: "bg-gray-100 text-gray-700 dark:bg-gray-500/25 dark:text-gray-200" },
  militaer:      { label: "Militär",        icon: Shield,          color: "bg-green-100 text-green-700 dark:bg-green-500/25 dark:text-green-200" },
};

const STATUS_META: Record<TimeOffStatus, { label: string; chip: string; dot: string }> = {
  beantragt: { label: "Offen",     chip: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/70 dark:bg-amber-500/15 dark:text-amber-200 dark:ring-amber-400/30", dot: "bg-amber-500" },
  genehmigt: { label: "Genehmigt", chip: "bg-green-50 text-green-700 ring-1 ring-green-200/70 dark:bg-green-500/15 dark:text-green-200 dark:ring-green-400/30", dot: "bg-green-500" },
  abgelehnt: { label: "Abgelehnt", chip: "bg-red-50 text-red-700 ring-1 ring-red-200/70 dark:bg-red-500/15 dark:text-red-200 dark:ring-red-400/30",           dot: "bg-red-500" },
};

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatDateRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function daysBetween(start: string, end: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const sDate = new Date(sy, sm - 1, sd);
  const eDate = new Date(ey, em - 1, ed);
  return Math.round((eDate.getTime() - sDate.getTime()) / 86400000) + 1;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Lade-Fenster der Initial-Query: alles was in den letzten 90 Tagen endete
 *  (oder noch laeuft/kommt). Aeltere Historie laedt der "Vergangen"-Bereich
 *  beim ersten Aufklappen nach. */
function pastCutoffISO(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function FerienView() {
  const supabase = createClient();
  const { profile, can, ready } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const showBackButton =
    pathname === "/ferien" && searchParams.get("from") === "dashboard";

  const canApprove = can("ferien:approve");
  const userId = profile?.id ?? null;

  const [entries, setEntries] = useState<TimeOffWithUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"meine" | "team">("meine");
  const [showPast, setShowPast] = useState(false);
  // Aeltere Historie (end_date < Cutoff) wird erst beim ersten Aufklappen
  // von "Vergangen" nachgeladen. Ref statt State, damit load() ohne
  // Re-Subscribe weiss, ob es wieder die volle Historie holen muss.
  const pastLoadedRef = useRef(false);
  const [pastLoading, setPastLoading] = useState(false);
  // Anzahl noch NICHT geladener Alt-Eintraege (head:true-Count) — haelt den
  // "Vergangen"-Bereich sichtbar/ehrlich, auch wenn im 90-Tage-Fenster
  // nichts Vergangenes liegt (sonst waere alte Historie unerreichbar).
  const [olderCount, setOlderCount] = useState(0);
  // Admin-Stats aus head:true-Count-Queries (Muster use-nav-counts) statt
  // Client-Rechnung ueber die komplette Historie.
  const [stats, setStats] = useState<{ offen: number; aktuellAbwesend: number; kommend: number } | null>(null);

  // Anfrage-Modal
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState<TimeOffType>("ferien");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [newNote, setNewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Decision-Modal (Admin)
  const [deciding, setDeciding] = useState<{ entry: TimeOffWithUser; decision: "genehmigen" | "ablehnen" } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from("time_off")
      .select("*, user:profiles!time_off_user_id_fkey(full_name)")
      .order("start_date", { ascending: true });
    // Initial nur das 90-Tage-Fenster — die komplette Historie kippt bei
    // Jahren an Antraegen. Sobald "Vergangen" einmal aufgeklappt wurde,
    // laedt load() wieder alles (sonst wuerden beim naechsten Reload nach
    // einer Aktion die aufgeklappten Alt-Eintraege verschwinden).
    if (!pastLoadedRef.current) q = q.gte("end_date", pastCutoffISO());
    const [{ data, error }, olderRes] = await Promise.all([
      q,
      pastLoadedRef.current
        ? Promise.resolve({ count: 0 })
        : supabase
            .from("time_off")
            .select("id", { count: "exact", head: true })
            .lt("end_date", pastCutoffISO()),
    ]);
    if (error) {
      TOAST.supabaseError(error, "Anträge konnten nicht geladen werden");
      setLoading(false);
      return;
    }
    setEntries((data as unknown as TimeOffWithUser[]) ?? []);
    setOlderCount(olderRes.count ?? 0);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  // Admin-Stat-Kacheln: exakt dieselben Filterbedingungen wie die fruehere
  // Client-Rechnung, nur serverseitig als head:true-Counts — Werte bleiben
  // identisch, aber es muss dafuer keine Historie mehr geladen werden.
  const loadStats = useCallback(async () => {
    if (!canApprove) { setStats(null); return; }
    const now = todayISO();
    const in7 = new Date();
    in7.setDate(in7.getDate() + 7);
    const in7Iso = `${in7.getFullYear()}-${String(in7.getMonth() + 1).padStart(2, "0")}-${String(in7.getDate()).padStart(2, "0")}`;
    const [offenRes, abwesendRes, kommendRes] = await Promise.all([
      supabase
        .from("time_off")
        .select("id", { count: "exact", head: true })
        .eq("status", "beantragt"),
      supabase
        .from("time_off")
        .select("id", { count: "exact", head: true })
        .eq("status", "genehmigt")
        .lte("start_date", now)
        .gte("end_date", now),
      supabase
        .from("time_off")
        .select("id", { count: "exact", head: true })
        .eq("status", "genehmigt")
        .gt("start_date", now)
        .lte("start_date", in7Iso),
    ]);
    setStats({
      offen: offenRes.count ?? 0,
      aktuellAbwesend: abwesendRes.count ?? 0,
      kommend: kommendRes.count ?? 0,
    });
  }, [supabase, canApprove]);

  useEffect(() => { loadStats(); }, [loadStats]);

  /** "Vergangen" auf-/zuklappen; beim ersten Aufklappen die aeltere
   *  Historie (end_date < Cutoff) nachladen — mit Spinner im Header. */
  async function togglePast() {
    if (!showPast && !pastLoadedRef.current) {
      setShowPast(true);
      setPastLoading(true);
      const { data, error } = await supabase
        .from("time_off")
        .select("*, user:profiles!time_off_user_id_fkey(full_name)")
        .lt("end_date", pastCutoffISO())
        .order("start_date", { ascending: true });
      if (error) {
        TOAST.supabaseError(error, "Vergangene Anträge konnten nicht geladen werden");
        setPastLoading(false);
        return;
      }
      pastLoadedRef.current = true;
      setOlderCount(0);
      setEntries((prev) => {
        const have = new Set(prev.map((e) => e.id));
        const older = ((data as unknown as TimeOffWithUser[]) ?? []).filter((e) => !have.has(e.id));
        return [...prev, ...older];
      });
      setPastLoading(false);
      return;
    }
    setShowPast((v) => !v);
  }

  const effectiveView = canApprove ? view : "meine";

  // Scope zuerst nach View (Meine vs Team), dann in 3 Sektionen splitten:
  // Zu genehmigen | Aktuell & Kommend | Vergangen.
  const { toApprove, activeUpcoming, past } = useMemo(() => {
    const today = todayISO();
    const scoped = effectiveView === "meine"
      ? entries.filter((e) => e.user_id === userId)
      : entries;

    const toApprove: TimeOffWithUser[] = [];
    const activeUpcoming: TimeOffWithUser[] = [];
    const past: TimeOffWithUser[] = [];

    for (const e of scoped) {
      const isDone = e.end_date < today || e.status === "abgelehnt";
      if (effectiveView === "team" && e.status === "beantragt" && !isDone) {
        // Admin-View: alle offenen Anträge landen in "Zu genehmigen",
        // egal ob Start heute oder in 3 Wochen.
        toApprove.push(e);
        continue;
      }
      if (isDone) {
        past.push(e);
      } else {
        activeUpcoming.push(e);
      }
    }

    // Sortierung: ASC für aktive Sektionen (was steht als nächstes an),
    // DESC für Vergangenes (neuestes zuerst wenn User aufklappt).
    toApprove.sort((a, b) => a.start_date.localeCompare(b.start_date));
    activeUpcoming.sort((a, b) => a.start_date.localeCompare(b.start_date));
    past.sort((a, b) => b.start_date.localeCompare(a.start_date));

    return { toApprove, activeUpcoming, past };
  }, [entries, effectiveView, userId]);

  function openCreate() {
    setNewType("ferien");
    setNewStart(todayISO());
    setNewEnd(todayISO());
    setNewNote("");
    setCreating(true);
  }

  async function submitCreate() {
    if (!newStart || !newEnd) {
      TOAST.error("Start- und End-Datum sind Pflicht");
      return;
    }
    if (newStart > newEnd) {
      TOAST.error("Start-Datum muss vor End-Datum liegen");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/time-off", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: newStart,
          end_date: newEnd,
          type: newType,
          note: newNote.trim() || null,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        TOAST.errorOr(json.error, "Anlegen fehlgeschlagen");
        return;
      }
      toast.success("Antrag eingereicht");
      setCreating(false);
      load();
      loadStats();
    } catch (err) {
      TOAST.error(err instanceof Error ? err.message : "Netzwerk-Fehler");
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteEntry(entry: TimeOffWithUser) {
    const ok = await confirm({
      title: "Antrag zurückziehen?",
      message: `${TYPE_META[entry.type].label} vom ${formatDateRange(entry.start_date, entry.end_date)} wird gelöscht.`,
      confirmLabel: "Zurückziehen",
      variant: "red",
    });
    if (!ok) return;
    const uid = userId;
    if (!uid) {
      TOAST.error("Nicht eingeloggt");
      return;
    }
    const { error, count } = await supabase
      .from("time_off")
      .delete({ count: "exact" })
      .eq("id", entry.id)
      .eq("user_id", uid)
      .eq("status", "beantragt");
    if (error) {
      TOAST.supabaseError(error, "Löschen fehlgeschlagen");
      return;
    }
    if (!count) {
      TOAST.error("Antrag konnte nicht zurückgezogen werden");
      return;
    }
    toast.success("Antrag zurückgezogen");
    load();
    loadStats();
  }

  function openDecide(entry: TimeOffWithUser, decision: "genehmigen" | "ablehnen") {
    setDeciding({ entry, decision });
    setDecisionNote("");
  }

  async function submitDecide() {
    if (!deciding) return;
    const isReject = deciding.decision === "ablehnen";
    if (isReject && !decisionNote.trim()) {
      TOAST.error("Begründung beim Ablehnen ist Pflicht");
      return;
    }
    const res = await fetch(`/api/time-off/${deciding.entry.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: deciding.decision,
        note: decisionNote.trim() || null,
      }),
    });
    const json = await res.json();
    if (!json.success) {
      TOAST.errorOr(json.error, "Speichern fehlgeschlagen");
      return;
    }
    toast.success(isReject ? "Antrag abgelehnt" : "Antrag genehmigt");
    setDeciding(null);
    setDecisionNote("");
    load();
    loadStats();
  }

  if (!ready) return null;

  const hasAnything = toApprove.length + activeUpcoming.length + past.length > 0 || olderCount > 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          {showBackButton && <BackButton fallbackHref="/dashboard" />}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">Abwesenheit</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {canApprove
                ? "Eigene Anträge einreichen, Team-Anträge genehmigen oder ablehnen."
                : "Ferien, Krankheit, Kompensation oder Frei-Tage beantragen."}
            </p>
          </div>
        </div>
        <button type="button" onClick={openCreate} className="kasten kasten-red shrink-0">
          <Plus className="h-3.5 w-3.5" />
          Neue Anfrage
        </button>
      </div>

      {/* Admin-Stats */}
      {canApprove && stats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard
            icon={<Inbox className="h-4 w-4" />}
            label="Offene Anträge"
            value={stats.offen}
            tone="amber"
            hint="Warten auf Entscheidung"
          />
          <StatCard
            icon={<UserRound className="h-4 w-4" />}
            label="Aktuell abwesend"
            value={stats.aktuellAbwesend}
            tone="red"
            hint="Heute nicht verfügbar"
          />
          <StatCard
            icon={<CalendarClock className="h-4 w-4" />}
            label="Kommende 7 Tage"
            value={stats.kommend}
            tone="blue"
            hint="Geplante Abwesenheiten"
          />
        </div>
      )}

      {/* Meine/Team-Toggle (nur Admin). Kein Status-/Typ-Filter mehr — die
          Sektionen ersetzen das. */}
      {canApprove && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setView("meine")}
            className={view === "meine" ? "kasten-active" : "kasten-toggle-off"}
          >
            Meine
          </button>
          <button
            type="button"
            onClick={() => setView("team")}
            className={view === "team" ? "kasten-active" : "kasten-toggle-off"}
          >
            Team
          </button>
        </div>
      )}

      {/* Sektionen */}
      {loading ? (
        <Loading />
      ) : !hasAnything ? (
        <div className="rounded-xl border border-dashed border-border bg-card">
          <EmptyState
            icon={Calendar}
            title={effectiveView === "meine" ? "Noch keine Anträge" : "Keine Anträge gefunden"}
            description={
              effectiveView === "meine"
                ? "Leg deine erste Anfrage an — Ferien, Krankheit, Kompensation oder Frei-Tag."
                : "In der Team-Ansicht sind aktuell keine Anträge sichtbar."
            }
          />
        </div>
      ) : (
        <div className="space-y-5">
          {toApprove.length > 0 && (
            <Section
              title="Zu genehmigen"
              count={toApprove.length}
              tone="amber"
            >
              {toApprove.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  showUser={effectiveView === "team"}
                  isOwn={e.user_id === userId}
                  canApprove={canApprove}
                  onDelete={() => deleteEntry(e)}
                  onDecide={(d) => openDecide(e, d)}
                />
              ))}
            </Section>
          )}

          {activeUpcoming.length > 0 && (
            <Section
              title="Aktuell & Kommend"
              count={activeUpcoming.length}
            >
              {activeUpcoming.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  showUser={effectiveView === "team"}
                  isOwn={e.user_id === userId}
                  canApprove={canApprove}
                  onDelete={() => deleteEntry(e)}
                  onDecide={(d) => openDecide(e, d)}
                />
              ))}
            </Section>
          )}

          {/* Aktuelle Ansicht ist leer aber es gibt Vergangenes — Hinweis
              statt komplett-leer Empty-State. */}
          {toApprove.length === 0 && activeUpcoming.length === 0 && (past.length > 0 || olderCount > 0) && (
            <div className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">
                Aktuell keine offenen oder kommenden Abwesenheiten.
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                {olderCount > 0 ? `${past.length}+` : past.length} vergangene Einträge unten aufklappbar.
              </p>
            </div>
          )}

          {(past.length > 0 || olderCount > 0) && (
            <div>
              <button
                type="button"
                onClick={togglePast}
                disabled={pastLoading}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-muted/40 transition-colors text-left"
              >
                {showPast ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Vergangen
                </span>
                <span className="text-[10px] font-semibold text-muted-foreground/70 tabular-nums">
                  {olderCount > 0 ? `${past.length}+` : past.length}
                </span>
                {pastLoading && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                )}
              </button>
              {showPast && (
                <div className="space-y-2 mt-2">
                  {past.map((e) => (
                    <EntryRow
                      key={e.id}
                      entry={e}
                      showUser={effectiveView === "team"}
                      isOwn={e.user_id === userId}
                      canApprove={canApprove}
                      onDelete={() => deleteEntry(e)}
                      onDecide={(d) => openDecide(e, d)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Anfrage-Modal */}
      <Modal
        open={creating}
        onClose={() => !submitting && setCreating(false)}
        title="Neue Anfrage"
        icon={<Plane className="h-5 w-5 text-blue-500" />}
        size="md"
        closable={!submitting}
      >
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Typ</label>
            <div className="grid grid-cols-2 gap-2 mt-1.5">
              {(Object.keys(TYPE_META) as TimeOffType[]).map((t) => {
                const meta = TYPE_META[t];
                const Icon = meta.icon;
                const active = newType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setNewType(t)}
                    className={`px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${
                      active
                        ? "border-2 border-foreground/30 bg-foreground/5"
                        : "border border-border hover:bg-muted/50"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Von</label>
              <Input
                type="date"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Bis</label>
              <Input
                type="date"
                value={newEnd}
                onChange={(e) => setNewEnd(e.target.value)}
                className="mt-1.5"
              />
            </div>
          </div>
          {newStart && newEnd && newStart <= newEnd && (
            <p className="text-xs text-muted-foreground">{daysBetween(newStart, newEnd)} Tag(e)</p>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notiz (optional)</label>
            <textarea
              value={newNote}
              onChange={(e) => setNewNote(e.target.value.slice(0, 500))}
              placeholder="z.B. Italien-Reise, Hochzeit, ..."
              rows={2}
              maxLength={500}
              className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-input bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setCreating(false)}
              disabled={submitting}
              className="kasten kasten-muted flex-1"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={submitCreate}
              disabled={submitting}
              className="kasten kasten-red flex-1"
            >
              <Plus className="h-3.5 w-3.5" />
              {submitting ? "Speichere…" : "Einreichen"}
            </button>
          </div>
        </div>
      </Modal>

      {/* Decision-Modal */}
      <Modal
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={deciding?.decision === "ablehnen" ? "Antrag ablehnen" : "Antrag genehmigen"}
        icon={
          deciding?.decision === "ablehnen"
            ? <X className="h-5 w-5 text-red-500" />
            : <Check className="h-5 w-5 text-green-500" />
        }
        size="md"
      >
        {deciding && (
          <div className="space-y-3">
            <div className="text-sm rounded-lg bg-muted/40 px-3 py-2">
              <p className="font-medium">{deciding.entry.user?.full_name ?? "Unbekannt"}</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {TYPE_META[deciding.entry.type].label} · {formatDateRange(deciding.entry.start_date, deciding.entry.end_date)}
                {" "}({daysBetween(deciding.entry.start_date, deciding.entry.end_date)} Tage)
              </p>
              {deciding.entry.note && (
                <p className="text-xs mt-1 italic">&bdquo;{deciding.entry.note}&ldquo;</p>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {deciding.decision === "ablehnen" ? "Begründung (Pflicht)" : "Notiz (optional)"}
              </label>
              <textarea
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value.slice(0, 500))}
                placeholder={deciding.decision === "ablehnen" ? "Warum wird abgelehnt?" : "z.B. Vertretung organisieren, ..."}
                rows={3}
                maxLength={500}
                autoFocus
                className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-input bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeciding(null)}
                className="kasten kasten-muted flex-1"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={submitDecide}
                className={`flex-1 ${deciding.decision === "ablehnen" ? "kasten kasten-red" : "kasten kasten-green"}`}
              >
                {deciding.decision === "ablehnen" ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                {deciding.decision === "ablehnen" ? "Ablehnen" : "Genehmigen"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {ConfirmModalElement}
    </div>
  );
}

// =====================================================================
// Section — Sektion-Header mit Titel + Count-Badge, dann die Rows
// =====================================================================

function Section({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone?: "amber";
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        <span
          className={`text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full ${
            tone === "amber"
              ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200"
              : "text-muted-foreground/70 bg-muted/60"
          }`}
        >
          {count}
        </span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

// =====================================================================
// StatCard
// =====================================================================

const STAT_TONE: Record<"amber" | "red" | "blue" | "green", { bubble: string }> = {
  amber: { bubble: "bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-amber-200" },
  red:   { bubble: "bg-red-100 text-red-700 dark:bg-red-500/25 dark:text-red-200" },
  blue:  { bubble: "bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200" },
  green: { bubble: "bg-green-100 text-green-700 dark:bg-green-500/25 dark:text-green-200" },
};

function StatCard({
  icon, label, value, tone, hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "amber" | "red" | "blue" | "green";
  hint?: string;
}) {
  const t = STAT_TONE[tone];
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-lg ${t.bubble}`}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {label}
          </p>
          <p className="text-2xl font-bold tabular-nums leading-tight mt-0.5">{value}</p>
        </div>
      </div>
      {hint && (
        <p className="text-[11px] text-muted-foreground mt-2">{hint}</p>
      )}
    </div>
  );
}

// =====================================================================
// EntryRow — eine Antrag-Zeile
// =====================================================================

interface EntryRowProps {
  entry: TimeOffWithUser;
  showUser: boolean;
  isOwn: boolean;
  canApprove: boolean;
  onDelete: () => void;
  onDecide: (decision: "genehmigen" | "ablehnen") => void;
}

function EntryRow({ entry, showUser, isOwn, canApprove, onDelete, onDecide }: EntryRowProps) {
  const typeMeta = TYPE_META[entry.type];
  const statusMeta = STATUS_META[entry.status];
  const TypeIcon = typeMeta.icon;
  const days = daysBetween(entry.start_date, entry.end_date);
  const canCancel = isOwn && entry.status === "beantragt";
  const canDecide = canApprove && entry.status === "beantragt";

  return (
    <div className="group rounded-xl border border-border bg-card px-3 sm:px-4 py-3 transition-colors hover:border-border/80 hover:bg-muted/20">
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          <span className={`inline-flex items-center justify-center w-10 h-10 rounded-lg ${typeMeta.color}`}>
            <TypeIcon className="h-5 w-5" />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {showUser && entry.user?.full_name ? (
              <>
                <span className="font-semibold text-sm text-foreground truncate">
                  {entry.user.full_name}
                </span>
                <span className="text-xs text-muted-foreground">· {typeMeta.label}</span>
              </>
            ) : (
              <span className="font-semibold text-sm text-foreground">
                {typeMeta.label}
              </span>
            )}
            {/* Status-Chip nur zeigen wenn nicht in der "Zu genehmigen"-
                Sektion (dort ist der Status per Definition beantragt und
                der Chip wäre redundant). Bei Meine-View immer zeigen. */}
            {!(canApprove && showUser && entry.status === "beantragt") && (
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full ${statusMeta.chip}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
                {statusMeta.label}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 tabular-nums">
            {formatDateRange(entry.start_date, entry.end_date)}
          </p>
          {entry.note && (
            <p className="text-xs italic mt-1 text-foreground/80 truncate">
              &bdquo;{entry.note}&ldquo;
            </p>
          )}
          {entry.status === "abgelehnt" && entry.decision_note && (
            <p className="text-[11px] mt-1.5 text-red-600 dark:text-red-300 flex items-start gap-1">
              <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
              <span>{entry.decision_note}</span>
            </p>
          )}
        </div>

        <div className="shrink-0 flex flex-col items-center justify-center px-2.5 min-w-[3rem] rounded-lg bg-muted/60 border border-border/60 py-1.5">
          <span className="text-base font-bold tabular-nums leading-tight text-foreground">
            {days}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">
            {days === 1 ? "Tag" : "Tage"}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {canDecide && (
            <>
              <button
                type="button"
                onClick={() => onDecide("ablehnen")}
                className="kasten kasten-red"
                data-tooltip="Ablehnen"
                aria-label="Ablehnen"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDecide("genehmigen")}
                className="kasten kasten-green"
                data-tooltip="Genehmigen"
                aria-label="Genehmigen"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {canCancel && !canDecide && (
            <button
              type="button"
              onClick={onDelete}
              className="kasten kasten-muted"
              data-tooltip="Zurückziehen"
              aria-label="Zurückziehen"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
