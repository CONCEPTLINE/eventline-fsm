"use client";

/**
 * /projekte — Liste aller Projekte die der User sehen darf.
 * MA sieht nur eigene (assigned_to = self); Admin/see-all sieht alle.
 *
 * Anzeige:
 *   - Status-Chip (angefragt/genehmigt/abgelehnt/abgeschlossen)
 *   - Titel + Assigned-User
 *   - Fortschritts-Balken (verbrauchte h / Budget h)
 * Klick oeffnet /projekte/[id].
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Loading } from "@/components/ui/spinner";
import { Plus, FolderKanban } from "lucide-react";
import { formatHours, progressPct, progressColorClass, PROJECT_STATUS_LABEL } from "@/lib/projekte-format";

interface ProjectRow {
  id: string;
  title: string;
  status: keyof typeof PROJECT_STATUS_LABEL;
  proposed_hours: number | null;
  budget_hours: number | null;
  assigned_to: string;
  created_at: string;
  assignee?: { full_name: string | null } | null;
  used_minutes: number;
}

export default function ProjektePage() {
  const supabase = createClient();
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const [rows, setRows] = useState<ProjectRow[] | null>(null);

  const load = useCallback(async () => {
    // 1. Projekte laden (RLS filtert automatisch)
    const { data: projects } = await supabase
      .from("projects")
      .select("id, title, status, proposed_hours, budget_hours, assigned_to, created_at, assignee:profiles!projects_assigned_to_fkey(full_name)")
      .eq("is_deleted", false)
      .order("created_at", { ascending: false });
    if (!projects) { setRows([]); return; }

    // 2. Verbrauchte Minuten pro Projekt aggregieren.
    const ids = projects.map((p) => p.id);
    const usedMap = new Map<string, number>();
    if (ids.length > 0) {
      const { data: entries } = await supabase
        .from("project_time_entries")
        .select("project_id, minutes")
        .in("project_id", ids);
      for (const e of entries ?? []) {
        usedMap.set(e.project_id as string, (usedMap.get(e.project_id as string) ?? 0) + (e.minutes as number));
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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FolderKanban className="h-6 w-6" /> Projekte
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Interne Projekte mit Stunden-Budget. {isAdmin && pendingCount > 0 && (
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                {pendingCount} offene {pendingCount === 1 ? "Anfrage" : "Anfragen"} zur Genehmigung
              </span>
            )}
          </p>
        </div>
        <Link href="/projekte/neu" className="kasten kasten-red">
          <Plus className="h-3.5 w-3.5" /> Neues Projekt
        </Link>
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
        <div className="space-y-2">
          {rows.map((p) => {
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
                        <span className="font-medium truncate">{p.title}</span>
                        <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${status.color}`}>
                          {status.label}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {p.assignee?.full_name ?? "—"} · angelegt {new Date(p.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                      </p>
                    </div>
                    <div className="w-56 shrink-0">
                      <div className="text-[11px] text-muted-foreground tabular-nums mb-1 text-right">{budgetLabel}</div>
                      {p.budget_hours != null && (
                        <div className="h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
                          <div
                            className={`h-full ${barColor} transition-all`}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
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
    </div>
  );
}
