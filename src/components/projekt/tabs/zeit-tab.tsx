"use client";

/**
 * ZeitTab -- Stempel + Zeit-Eintraege. Default fuer Techniker.
 *
 *   - StampWidget: gross und selbsterklaerend (grosser gruener Balken wenn
 *     eingestempelt mit Live-Timer). Nur sichtbar wenn User Mitglied.
 *   - Kontext-Zeile mit Budget-Fortschritt (geplant vs Ist).
 *   - TimeEntriesCard: alle Buchungen des Projekts.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Clock, Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatHours, progressColorClass } from "@/lib/projekte-format";
import type { Project, TimeEntry } from "../types";

/* ============================================================
   STAMP WIDGET
   ============================================================ */

function StampWidget({
  projectId, openEntry, budgetAufgebraucht, me, isMember, canJoin, onDone,
}: {
  projectId: string;
  openEntry: TimeEntry | null;
  budgetAufgebraucht: boolean;
  me: string | null;
  isMember: boolean;
  canJoin: boolean;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(openEntry?.description ?? "");
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!openEntry) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [openEntry]);

  async function join() {
    if (!me) return;
    setBusy(true);
    const { error } = await supabase.from("project_members").insert({ project_id: projectId, user_id: me });
    setBusy(false);
    if (error) { toast.error("Login fehlgeschlagen: " + error.message); return; }
    toast.success("Auf Projekt eingeloggt");
    onDone();
  }

  async function stampIn() {
    if (budgetAufgebraucht) return toast.error("Budget aufgebraucht.");
    if (!me) return;
    setBusy(true);
    // Konsolidierung Migration 212: Projekt-Stempel leben jetzt in
    // time_entries. Der Doppelstempel-Check muss deshalb ueber ALLE
    // offenen Eintraege laufen (Auftrag/Projekt/Andere Arbeit); die
    // DB-Constraint time_entries_one_active_per_user haerte das ab.
    const { data: existing } = await supabase
      .from("time_entries")
      .select("id, project_id, job_id")
      .eq("user_id", me)
      .is("clock_out", null)
      .maybeSingle();
    if (existing) {
      setBusy(false);
      const msg = existing.project_id
        ? "Du bist bereits auf einem anderen Projekt eingestempelt."
        : existing.job_id
          ? "Du bist bereits auf einem Auftrag eingestempelt. Stempel dort erst aus."
          : "Du bist bereits eingestempelt (Andere Arbeit). Stempel erst aus.";
      toast.error(msg);
      return;
    }
    const { error } = await supabase.from("time_entries").insert({
      project_id: projectId,
      user_id: me,
      clock_in: new Date().toISOString(),
      description: note.trim() || null,
    });
    setBusy(false);
    if (error) { toast.error("Einstempeln fehlgeschlagen: " + error.message); return; }
    toast.success("Eingestempelt");
    setNote("");
    onDone();
  }

  async function stampOut() {
    if (!openEntry) return;
    setBusy(true);
    const { error } = await supabase.from("time_entries").update({
      clock_out: new Date().toISOString(),
      description: note.trim() || openEntry.description || null,
    }).eq("id", openEntry.id);
    setBusy(false);
    if (error) { toast.error("Ausstempeln fehlgeschlagen: " + error.message); return; }
    toast.success("Ausgestempelt");
    onDone();
  }

  if (canJoin) {
    return (
      <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
        <LogIn className="h-4 w-4 text-muted-foreground shrink-0" />
        <p className="text-sm flex-1 text-muted-foreground">Du bist noch nicht auf diesem Projekt eingeloggt.</p>
        <button onClick={join} disabled={busy} className="kasten kasten-green">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
          Einloggen & Stempeln
        </button>
      </div>
    );
  }

  if (!isMember) return null;

  if (openEntry) {
    const startMs = new Date(openEntry.clock_in!).getTime();
    const elapsed = Math.max(0, Date.now() - startMs);
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    return (
      <div className="rounded-xl border-2 border-green-500/60 bg-green-500/5 p-4 flex items-center gap-4 flex-wrap">
        <div className="h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse" />
        <div className="flex-1 min-w-40">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-400">
            Eingestempelt seit {new Date(openEntry.clock_in!).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}
          </p>
          <p className="text-2xl font-bold tabular-nums text-green-700 dark:text-green-400">
            {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
          </p>
        </div>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Notiz (optional)" className="max-w-xs" />
        <button onClick={stampOut} disabled={busy} className="kasten kasten-red">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />} Ausstempeln
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4 flex items-center gap-3 flex-wrap">
      <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Woran arbeitest du? (optional)"
        className="flex-1 min-w-40"
      />
      <button
        onClick={stampIn}
        disabled={busy || budgetAufgebraucht}
        className="kasten kasten-green shrink-0"
        data-tooltip={budgetAufgebraucht ? "Budget aufgebraucht" : undefined}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
        {budgetAufgebraucht ? "Budget aufgebraucht" : "Einstempeln"}
      </button>
    </div>
  );
}

/* ============================================================
   BUDGET-CONTEXT (geplant vs Ist)
   ============================================================ */

function BudgetContext({ project, usedMin, pct }: { project: Project; usedMin: number; pct: number }) {
  if (project.budget_hours == null) return null;
  const usedH = usedMin / 60;
  const remainingH = Math.max(0, project.budget_hours - usedH);
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
        <span>Geplant: <strong className="text-foreground/80">{project.budget_hours.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h</strong></span>
        <span>Ist: <strong className="text-foreground/80 tabular-nums">{formatHours(usedMin)}</strong></span>
        <span>Rest: <strong className="text-foreground/80 tabular-nums">{remainingH.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h</strong></span>
      </div>
      <div className="h-2 rounded-full bg-foreground/[0.08] dark:bg-foreground/[0.22] overflow-hidden">
        <div className={cn("h-full transition-all", progressColorClass(pct))} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

/* ============================================================
   TIME ENTRIES
   ============================================================ */

function TimeEntriesCard({ entries, isAdmin }: { entries: TimeEntry[]; isAdmin: boolean }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zeit-Einträge ({entries.length})</p>
        </div>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Noch keine Zeit gebucht.</p>
        ) : (
          <div className="space-y-1 max-h-[32rem] overflow-y-auto">
            {entries.map((e) => {
              const isOpen = !!e.clock_in && !e.clock_out;
              return (
                <div key={e.id} className={`flex items-center gap-2 p-2 rounded-lg text-sm ${isOpen ? "bg-green-50 dark:bg-green-500/10 border border-green-500/30" : "bg-muted/20"}`}>
                  <Clock className={`h-3.5 w-3.5 shrink-0 ${isOpen ? "text-green-500 animate-pulse" : "text-muted-foreground"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {isOpen
                        ? <span className="text-sm font-medium text-green-600 dark:text-green-400">Läuft …</span>
                        : <span className="text-sm font-medium tabular-nums">{formatHours(e.minutes)}</span>
                      }
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(e.entry_date + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                        {e.clock_in && ` · ${new Date(e.clock_in).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}`}
                        {e.clock_out && ` – ${new Date(e.clock_out).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}`}
                      </span>
                      {isAdmin && e.user?.full_name && <span className="text-[11px] text-muted-foreground">· {e.user.full_name}</span>}
                    </div>
                    {e.description && <p className="text-[11px] text-muted-foreground truncate">{e.description}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   ZEIT TAB (Export)
   ============================================================ */

export function ZeitTab({
  project, entries, openEntry, me, isMember, isAdmin, canJoin, usedMin, pct, onReload,
}: {
  project: Project;
  entries: TimeEntry[];
  openEntry: TimeEntry | null;
  me: string | null;
  isMember: boolean;
  isAdmin: boolean;
  canJoin: boolean;
  usedMin: number;
  pct: number;
  onReload: () => void;
}) {
  return (
    <div className="space-y-4">
      {project.status === "genehmigt" && (isMember || canJoin) && (
        <StampWidget
          projectId={project.id}
          openEntry={openEntry}
          budgetAufgebraucht={pct >= 100}
          me={me}
          isMember={isMember}
          canJoin={canJoin}
          onDone={onReload}
        />
      )}
      <BudgetContext project={project} usedMin={usedMin} pct={pct} />
      <TimeEntriesCard entries={entries} isAdmin={isAdmin} />
    </div>
  );
}
