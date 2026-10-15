"use client";

// Karte "Täglicher Sicherheits-Check" auf /sicherheit. Zeigt den letzten Lauf
// (security_runs) + Befunde (security_findings), den Klartext-Rapport der lokalen
// KI (narrative) und einen "jetzt prüfen"-Knopf (POST /api/sicherheit/check).

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDateTimeFull } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { ShieldCheck, ShieldAlert, AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type Run = {
  id: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  critical: number;
  warnings: number;
  checks: number;
  narrative: string | null;
  source: string;
};

type Finding = { severity: string; category: string; title: string; occurred_at: string };

const SEV_RANK: Record<string, number> = { critical: 0, warn: 1, info: 2 };

export function SicherheitsCheckCard() {
  const supabase = createClient();
  const [run, setRun] = useState<Run | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const { data: r } = await supabase
      .from("security_runs")
      .select("id, started_at, finished_at, ok, critical, warnings, checks, narrative, source")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const latest = r as Run | null;
    setRun(latest);
    if (latest) {
      const { data: f } = await supabase
        .from("security_findings")
        .select("severity, category, title, occurred_at")
        .eq("run_id", latest.id)
        .limit(100);
      const rows = (f ?? []) as Finding[];
      rows.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
      setFindings(rows);
    } else {
      setFindings([]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function pruefen() {
    setChecking(true);
    try {
      const res = await fetch("/api/sicherheit/check", { method: "POST" });
      const j = (await res.json().catch(() => null)) as { success?: boolean; critical?: number; warnings?: number; error?: string } | null;
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Prüfung fehlgeschlagen");
      toast.success(
        (j.critical ?? 0) > 0 ? `${j.critical} kritische Befunde` : (j.warnings ?? 0) > 0 ? `${j.warnings} Warnungen` : "Keine Auffälligkeiten",
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Prüfung fehlgeschlagen");
    } finally {
      setChecking(false);
    }
  }

  const status = !run ? "none" : run.critical > 0 ? "critical" : run.warnings > 0 ? "warn" : "ok";
  const StatusIcon = status === "critical" ? ShieldAlert : status === "warn" ? AlertTriangle : ShieldCheck;
  const statusColor =
    status === "critical"
      ? "text-red-600 dark:text-red-400"
      : status === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-emerald-600 dark:text-emerald-400";
  const statusText =
    status === "none"
      ? "Noch kein Check gelaufen"
      : status === "critical"
        ? `${run?.critical} kritisch${(run?.warnings ?? 0) > 0 ? `, ${run?.warnings} Warnungen` : ""}`
        : status === "warn"
          ? `${run?.warnings} Warnung${run?.warnings === 1 ? "" : "en"}`
          : "Keine Auffälligkeiten";

  return (
    <Card className="bg-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <StatusIcon className={`h-6 w-6 shrink-0 ${statusColor}`} />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold">Täglicher Sicherheits-Check</h2>
            <p className={`text-sm font-medium ${statusColor}`}>
              {loading ? "Lädt…" : statusText}
            </p>
            {run && !loading && (
              <p className="text-[11px] text-muted-foreground">
                Zuletzt {formatDateTimeFull(run.started_at)} · {run.checks} Prüfungen{run.source === "manuell" ? " · manuell" : ""}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={pruefen}
            disabled={checking}
            className="kasten shrink-0 inline-flex items-center gap-1.5 text-xs disabled:opacity-60"
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {checking ? "Prüft…" : "Jetzt prüfen"}
          </button>
        </div>

        {run?.narrative && (
          <p className="text-xs text-muted-foreground whitespace-pre-line border-l-2 border-border pl-3">{run.narrative}</p>
        )}

        {!loading && findings.length > 0 && (
          <div className="divide-y divide-border max-h-80 overflow-y-auto">
            {findings.map((f, i) => {
              const c = f.severity === "critical" ? "text-red-600 dark:text-red-400" : f.severity === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
              const dot = f.severity === "critical" ? "●" : f.severity === "warn" ? "▲" : "·";
              return (
                <div key={i} className="py-2 flex items-start gap-2 text-xs">
                  <span className={`${c} shrink-0 w-3 text-center`} aria-hidden>
                    {dot}
                  </span>
                  <p className="flex-1 min-w-0">
                    {f.title}
                    <span className="text-muted-foreground/60"> · {f.category}</span>
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
