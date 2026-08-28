"use client";

/**
 * /projekte — Projekt-Liste als Cards (Grid 1/2/3-Spalten).
 * Layout portiert von conceptline: PJ-Nr, Titel, Status, Assignee-Avatare,
 * eingestempelt-Indikator (pulsierender grüner Punkt), Deadline.
 * Archiv-Button rechts oben wie in /auftraege.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Loading } from "@/components/ui/spinner";
import { Plus, Archive } from "lucide-react";
import {
  formatHours, progressPct, progressColorClass, PROJECT_STATUS_LABEL,
  PROJECT_ARCHIVE_STATUSES, formatProjectNumber,
} from "@/lib/projekte-format";
import { cn } from "@/lib/utils";

interface Member { user_id: string; full_name: string | null }
interface Stamper { user_id: string; full_name: string | null }

interface ProjectRow {
  id: string;
  project_number: number | null;
  title: string;
  status: keyof typeof PROJECT_STATUS_LABEL;
  proposed_hours: number | null;
  budget_hours: number | null;
  assigned_to: string;
  created_at: string;
  goal_date: string | null;
  completion_success: boolean | null;
  assignee?: { full_name: string | null } | null;
  used_minutes: number;
  members: Member[];
  stampers: Stamper[]; // aktuell eingestempelte
}

export default function ProjektePage() {
  const supabase = createClient();
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [showArchive, setShowArchive] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("projekte-archive") === "true" : false,
  );
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("projekte-archive", String(showArchive));
  }, [showArchive]);

  const load = useCallback(async () => {
    const { data: projects } = await supabase
      .from("projects")
      .select(`
        id, project_number, title, status, proposed_hours, budget_hours,
        assigned_to, created_at, goal_date, completion_success,
        assignee:profiles!projects_assigned_to_fkey(full_name)
      `)
      .eq("is_deleted", false)
      .order("project_number", { ascending: false });
    if (!projects) { setRows([]); return; }

    const ids = projects.map((p) => p.id);
    const usedMap = new Map<string, number>();
    const membersMap = new Map<string, Member[]>();
    const stampersMap = new Map<string, Stamper[]>();

    if (ids.length > 0) {
      const [entriesRes, membersRes, stampersRes] = await Promise.all([
        supabase.from("project_time_entries").select("project_id, minutes").in("project_id", ids),
        supabase.from("project_members")
          .select("project_id, user_id, member:profiles!project_members_user_id_fkey(full_name)")
          .in("project_id", ids),
        // Wer ist aktuell eingestempelt (clock_out IS NULL)?
        supabase.from("project_time_entries")
          .select("project_id, user_id, user:profiles!project_time_entries_user_id_fkey(full_name)")
          .in("project_id", ids)
          .is("clock_out", null),
      ]);
      for (const e of entriesRes.data ?? []) {
        usedMap.set(e.project_id as string, (usedMap.get(e.project_id as string) ?? 0) + ((e.minutes as number | null) ?? 0));
      }
      for (const m of membersRes.data ?? []) {
        const pid = m.project_id as string;
        const list = membersMap.get(pid) ?? [];
        list.push({
          user_id: m.user_id as string,
          full_name: (Array.isArray(m.member) ? m.member[0] : m.member)?.full_name ?? null,
        });
        membersMap.set(pid, list);
      }
      for (const s of stampersRes.data ?? []) {
        const pid = s.project_id as string;
        const list = stampersMap.get(pid) ?? [];
        list.push({
          user_id: s.user_id as string,
          full_name: (Array.isArray(s.user) ? s.user[0] : s.user)?.full_name ?? null,
        });
        stampersMap.set(pid, list);
      }
    }

    setRows(projects.map((p) => ({
      ...p,
      assignee: Array.isArray(p.assignee) ? p.assignee[0] : p.assignee,
      used_minutes: usedMap.get(p.id) ?? 0,
      members: membersMap.get(p.id) ?? [],
      stampers: stampersMap.get(p.id) ?? [],
    })) as ProjectRow[]);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const pendingCount = (rows ?? []).filter((r) => r.status === "angefragt").length;
  const archiveCount = (rows ?? []).filter((r) => PROJECT_ARCHIVE_STATUSES.includes(r.status)).length;
  const visibleRows = (rows ?? []).filter((r) =>
    showArchive
      ? PROJECT_ARCHIVE_STATUSES.includes(r.status)
      : !PROJECT_ARCHIVE_STATUSES.includes(r.status),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{showArchive ? "Projekte Archiv" : "Projekte"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Interne Projekte mit Stunden-Budget.
            {isAdmin && pendingCount > 0 && !showArchive && (
              <span className="text-amber-600 dark:text-amber-400 font-medium ml-1">
                · {pendingCount} offene {pendingCount === 1 ? "Anfrage" : "Anfragen"}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowArchive(!showArchive)}
            className={showArchive ? "kasten-active" : "kasten-toggle-off"}
          >
            <Archive className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{showArchive ? "Aktive anzeigen" : `Archiv (${archiveCount})`}</span>
            <span className="sm:hidden">{showArchive ? "Aktiv" : `Archiv (${archiveCount})`}</span>
          </button>
          <Link href="/projekte/neu" className="kasten kasten-red">
            <Plus className="h-3.5 w-3.5" /> Neues Projekt
          </Link>
        </div>
      </div>

      {rows === null ? (
        <Loading />
      ) : visibleRows.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? "Noch keine Projekte." : showArchive ? "Noch keine archivierten Projekte." : "Keine aktiven Projekte."}
          {rows.length === 0 && (
            <div className="mt-4">
              <Link href="/projekte/neu" className="kasten kasten-red inline-flex">
                <Plus className="h-3.5 w-3.5" /> Erstes Projekt anlegen
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibleRows.map((p) => <ProjectCard key={p.id} p={p} />)}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ p }: { p: ProjectRow }) {
  const status = PROJECT_STATUS_LABEL[p.status];
  const pct = progressPct(p.used_minutes, p.budget_hours);
  const barColor = progressColorClass(pct);
  const isGenehmigt = p.status === "genehmigt";
  const overdue = !!p.goal_date && new Date(p.goal_date + "T23:59:59") < new Date()
    && !["abgeschlossen", "storniert", "abgelehnt"].includes(p.status);
  const hasStampers = p.stampers.length > 0;

  return (
    <div className={cn(
      "group relative flex flex-col gap-3 rounded-xl border bg-card p-4 transition-all hover:shadow-md",
      isGenehmigt && "border-emerald-500/40 ring-1 ring-emerald-500/10",
      hasStampers && "!border-emerald-500 ring-2 ring-emerald-500/20 bg-emerald-500/[0.03] dark:bg-emerald-500/[0.06]",
    )}>
      <Link href={`/projekte/${p.id}`} className="absolute inset-0 rounded-xl" aria-label={p.title} />

      {/* Kopf: Nr + Status */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono font-semibold text-muted-foreground">{formatProjectNumber(p.project_number)}</span>
        <div className="flex items-center gap-1.5">
          {hasStampers ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-md bg-emerald-500 text-white">
              <span className="h-1.5 w-1.5 rounded-full bg-white/90 animate-pulse" /> Aktiv
            </span>
          ) : (
            <span className={cn("inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full", status.color)}>
              {status.label}
            </span>
          )}
          {p.completion_success === true && (
            <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">✓</span>
          )}
          {p.completion_success === false && (
            <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">✗</span>
          )}
        </div>
      </div>

      {/* Titel */}
      <div className="min-h-[2.5rem]">
        <h3 className="font-semibold leading-snug line-clamp-2 group-hover:text-red-600 dark:group-hover:text-red-400 transition-colors">
          {p.title}
        </h3>
      </div>

      {/* Avatars + Stamper-Indikator */}
      <div className="flex items-center justify-between gap-2 min-h-6">
        <AvatarStack members={p.members} stampers={p.stampers} />
        {p.goal_date && (
          <span className={cn(
            "text-[11px] shrink-0",
            overdue ? "text-red-600 dark:text-red-400 font-medium" : "text-muted-foreground",
          )}>
            {overdue && "⚠ "}
            {new Date(p.goal_date + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "short" })}
          </span>
        )}
      </div>

      {/* Budget-Progress */}
      <div className="mt-auto">
        {p.budget_hours != null ? (
          <>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums mb-1">
              <span>{formatHours(p.used_minutes)} / {p.budget_hours.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h</span>
              <span>{Math.round(pct)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
              <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">
            {p.status === "angefragt" ? `Vorschlag ${p.proposed_hours ?? "?"} h — wartet auf Genehmigung` :
             p.status === "entwurf" ? "Entwurf — noch nicht eingereicht" :
             p.status === "abgelehnt" ? "Abgelehnt" : "Kein Budget"}
          </p>
        )}
      </div>
    </div>
  );
}

/** Avatar-Stack analog conceptline: Initialen-Chips, eingestempelte hervorgehoben (grün mit puls). */
function AvatarStack({ members, stampers }: { members: Member[]; stampers: Stamper[] }) {
  if (members.length === 0) {
    return <span className="text-[11px] text-muted-foreground/60 italic">niemand eingeloggt</span>;
  }
  const stamperIds = new Set(stampers.map((s) => s.user_id));
  const shown = members.slice(0, 5);
  const overflow = members.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((m) => {
        const isStamping = stamperIds.has(m.user_id);
        const initial = (m.full_name?.trim()?.[0] ?? "?").toUpperCase();
        return (
          <span
            key={m.user_id}
            className={cn(
              "h-6 w-6 rounded-full border-2 border-card flex items-center justify-center text-[10px] font-bold shrink-0",
              isStamping
                ? "bg-emerald-500 text-white ring-2 ring-emerald-500/40 animate-pulse"
                : "bg-foreground/10 dark:bg-foreground/15 text-foreground/70",
            )}
            data-tooltip={`${m.full_name ?? "—"}${isStamping ? " · eingestempelt" : ""}`}
          >
            {initial}
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="h-6 w-6 rounded-full border-2 border-card bg-muted flex items-center justify-center text-[10px] font-semibold text-muted-foreground shrink-0">
          +{overflow}
        </span>
      )}
    </div>
  );
}
