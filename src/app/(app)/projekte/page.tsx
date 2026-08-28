"use client";

/**
 * /projekte — Projekt-Liste.
 * Tab-Style Aktiv/Archiv (wie in /einstellungen mit kasten-toggle-off / kasten-active).
 * Zeigt Projektnummer, Titel, Status, Assignee, Fortschritt.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Loading } from "@/components/ui/spinner";
import { Plus, FolderKanban, Archive } from "lucide-react";
import {
  formatHours, progressPct, progressColorClass, PROJECT_STATUS_LABEL,
  PROJECT_ARCHIVE_STATUSES, formatProjectNumber,
} from "@/lib/projekte-format";

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
}

export default function ProjektePage() {
  const supabase = createClient();
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  // Persist across reloads (wie /auftraege) — sonst muss der User nach jedem
  // Reload wieder ins Archiv klicken.
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
    if (ids.length > 0) {
      const { data: entries } = await supabase
        .from("project_time_entries")
        .select("project_id, minutes")
        .in("project_id", ids);
      for (const e of entries ?? []) {
        usedMap.set(e.project_id as string, (usedMap.get(e.project_id as string) ?? 0) + ((e.minutes as number | null) ?? 0));
      }
    }

    setRows(projects.map((p) => ({
      ...p,
      assignee: Array.isArray(p.assignee) ? p.assignee[0] : p.assignee,
      used_minutes: usedMap.get(p.id) ?? 0,
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
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FolderKanban className="h-6 w-6" /> {showArchive ? "Projekte Archiv" : "Projekte"}
          </h1>
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
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <FolderKanban className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">Noch keine Projekte.</p>
            <Link href="/projekte/neu" className="kasten kasten-red mt-4 inline-flex">
              <Plus className="h-3.5 w-3.5" /> Erstes Projekt anlegen
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          {visibleRows.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {showArchive ? "Noch keine archivierten Projekte." : "Keine aktiven Projekte."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {visibleRows.map((p) => {
                const status = PROJECT_STATUS_LABEL[p.status];
                const pct = progressPct(p.used_minutes, p.budget_hours);
                const barColor = progressColorClass(pct);
                const budgetLabel = p.budget_hours != null
                  ? `${formatHours(p.used_minutes)} / ${p.budget_hours.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h`
                  : p.proposed_hours != null
                    ? `Vorschlag ${p.proposed_hours.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h`
                    : "—";
                return (
                  <Link key={p.id} href={`/projekte/${p.id}`} className="block">
                    <Card className="bg-card hover:bg-foreground/[0.02] transition-colors">
                      <CardContent className="p-4 flex items-center gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-foreground/[0.06] text-[10px] font-mono font-semibold tabular-nums shrink-0">
                              {formatProjectNumber(p.project_number)}
                            </span>
                            <span className="font-medium truncate">{p.title}</span>
                            <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${status.color}`}>
                              {status.label}
                            </span>
                            {p.completion_success === true && (
                              <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">
                                Erfolgreich
                              </span>
                            )}
                            {p.completion_success === false && (
                              <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">
                                Nicht erfolgreich
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {p.assignee?.full_name ?? "—"}
                            {p.goal_date && ` · Deadline ${new Date(p.goal_date + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}`}
                          </p>
                        </div>
                        <div className="w-56 shrink-0">
                          <div className="text-[11px] text-muted-foreground tabular-nums mb-1 text-right">{budgetLabel}</div>
                          {p.budget_hours != null && (
                            <div className="h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
                              <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
