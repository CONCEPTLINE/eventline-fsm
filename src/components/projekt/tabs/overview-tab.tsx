"use client";

/**
 * OverviewTab -- Kopf-Inhalt fuer Admins/Teamleiter:
 *   - TeamBudgetPanel (Team + Budget + Stempel-Buttons)  [nur wenn genehmigt]
 *   - InfoCard (Ziel, Beschreibung, Notizen)
 *   - AppointmentsCard (Termine)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  Clock, Loader2, Trash2, Edit3, FileText, Target, StickyNote, Calendar as CalIcon,
  Plus, LogIn, LogOut, MessageSquare, Save,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Appointment, Member, Project, TimeEntry } from "../types";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";

/* ============================================================
   INFO
   ============================================================ */

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">{icon}{label}</p>
      {children}
    </div>
  );
}
function ReadField({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5 flex items-center gap-1.5">{icon}{label}</p>
      {children}
    </div>
  );
}

function InfoCard({ project, canEdit, onSaved }: { project: Project; canEdit: boolean; onSaved: () => void }) {
  const supabase = createClient();
  const [editing, setEditing] = useState(false);
  const [goalText, setGoalText] = useState(project.goal_text ?? "");
  const [goalDate, setGoalDate] = useState(project.goal_date ?? "");
  const [description, setDescription] = useState(project.description ?? "");
  const [notes, setNotes] = useState(project.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const { error } = await supabase.from("projects").update({
      goal_text: goalText.trim() || null,
      goal_date: goalDate || null,
      description: description.trim() || null,
      notes: notes.trim() || null,
    }).eq("id", project.id);
    setSaving(false);
    if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    setEditing(false);
    onSaved();
  }

  const daysToGoal = useMemo(() => {
    if (!project.goal_date) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(project.goal_date + "T12:00:00");
    return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  }, [project.goal_date]);

  const isEmpty = !project.goal_text && !project.goal_date && !project.description && !project.notes;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">Info</p>
          {canEdit && !editing && (
            <button onClick={() => setEditing(true)} className="kasten kasten-muted text-[11px] py-1 px-2">
              <Edit3 className="h-3 w-3" /> Bearbeiten
            </button>
          )}
        </div>

        {editing ? (
          <div className="space-y-3">
            <Field icon={<Target className="h-3.5 w-3.5" />} label="Ziel">
              <textarea
                value={goalText}
                onChange={(e) => setGoalText(e.target.value)}
                rows={2}
                placeholder="Was soll konkret erreicht werden?"
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
                autoFocus
              />
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] text-muted-foreground/70">Deadline:</span>
                <Input type="date" value={goalDate} onChange={(e) => setGoalDate(e.target.value)} className="h-8 max-w-40" />
              </div>
            </Field>
            <Field icon={<FileText className="h-3.5 w-3.5" />} label="Beschreibung">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Konkrete Schritte, Kontext, Rahmenbedingungen …"
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </Field>
            <Field icon={<StickyNote className="h-3.5 w-3.5" />} label="Notizen">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Gedanken, Zwischenstände, Kontakte …"
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </Field>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => {
                  setEditing(false);
                  setGoalText(project.goal_text ?? "");
                  setGoalDate(project.goal_date ?? "");
                  setDescription(project.description ?? "");
                  setNotes(project.notes ?? "");
                }}
                disabled={saving}
                className="kasten kasten-muted flex-1"
              >Abbrechen</button>
              <button onClick={save} disabled={saving} className="kasten kasten-red flex-1">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Speichern
              </button>
            </div>
          </div>
        ) : isEmpty ? (
          <p className="text-xs text-muted-foreground italic">Noch keine Angaben. {canEdit && "Klick oben rechts zum Bearbeiten."}</p>
        ) : (
          <div className="space-y-3">
            {(project.goal_text || project.goal_date) && (
              <ReadField icon={<Target className="h-3.5 w-3.5" />} label="Ziel">
                {project.goal_text && <p className="text-sm whitespace-pre-wrap">{project.goal_text}</p>}
                {project.goal_date && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Deadline: <strong>{new Date(project.goal_date + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "numeric", month: "long", year: "numeric" })}</strong>
                    {daysToGoal != null && (
                      daysToGoal > 0
                        ? <span className="ml-2 text-muted-foreground/70">(in {daysToGoal} Tagen)</span>
                        : daysToGoal === 0
                          ? <span className="ml-2 text-amber-600 dark:text-amber-400">(heute)</span>
                          : <span className="ml-2 text-red-600 dark:text-red-400">({-daysToGoal} Tage überfällig)</span>
                    )}
                  </p>
                )}
              </ReadField>
            )}
            {project.description && (
              <ReadField icon={<FileText className="h-3.5 w-3.5" />} label="Beschreibung">
                <p className="text-sm whitespace-pre-wrap">{project.description}</p>
              </ReadField>
            )}
            {project.notes && (
              <ReadField icon={<StickyNote className="h-3.5 w-3.5" />} label="Notizen">
                <p className="text-sm whitespace-pre-wrap">{project.notes}</p>
              </ReadField>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   APPOINTMENTS
   ============================================================ */

function AppointmentsCard({ projectId, appts, canAdd, onOpen, onOpenNotes, onReload }: {
  projectId: string;
  appts: Appointment[];
  canAdd: boolean;
  onOpen: (a: Appointment | "new") => void;
  onOpenNotes: (a: Appointment) => void;
  onReload: () => void;
}) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  async function del(id: string, title: string) {
    const ok = await confirm({
      title: "Termin löschen?",
      message: `"${title}" wird endgültig entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("project_appointments").delete().eq("id", id);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    toast.success("Gelöscht");
    onReload();
  }
  const _projectId = projectId; void _projectId;
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <CalIcon className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">Termine ({appts.length})</p>
          {canAdd && (
            <button onClick={() => onOpen("new")} className="kasten kasten-muted text-[11px] py-1 px-2">
              <Plus className="h-3 w-3" /> Neu
            </button>
          )}
        </div>
        {appts.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Noch keine Termine.</p>
        ) : (
          <div className="space-y-1">
            {appts.map((a) => (
              <div key={a.id} className="flex items-start gap-2 p-2 rounded-lg bg-muted/20 text-sm">
                <CalIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium truncate">{a.title}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {new Date(a.start_time).toLocaleString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    {a.end_time && ` – ${new Date(a.end_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}`}
                    {a.assignee?.full_name && ` · ${a.assignee.full_name}`}
                  </div>
                  {a.description && (
                    <p className="text-[11px] text-muted-foreground whitespace-pre-wrap line-clamp-3">{a.description}</p>
                  )}
                  {a.participants.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pt-0.5">
                      {a.participants.map((p) => {
                        const initials = p.name.split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
                        const tone = p.customer_id
                          ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                          : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
                        return (
                          <span
                            key={p.id}
                            data-tooltip={p.name + (p.customer_id ? " (Kunde)" : "")}
                            className={`h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold cursor-default ${tone}`}
                          >
                            {initials}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="pt-1">
                    <button
                      onClick={() => onOpenNotes(a)}
                      className="kasten kasten-muted text-[10px] py-0.5 px-1.5"
                      data-tooltip="Gesprächs-Notizen"
                    >
                      <MessageSquare className="h-3 w-3" /> Notizen ({a.notesCount})
                    </button>
                  </div>
                </div>
                {canAdd && (
                  <div className="flex items-start gap-1 shrink-0">
                    <button onClick={() => onOpen(a)} className="text-muted-foreground hover:text-foreground" aria-label="Bearbeiten"><Edit3 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => del(a.id, a.title)} className="text-muted-foreground hover:text-destructive" aria-label="Löschen"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {ConfirmModalElement}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   TEAM + BUDGET PANEL
   ============================================================ */

function TeamBudgetPanel({
  project, members, entries, openEntry, me, isMember, isAdmin, canJoin, usedMin, pct, onDone,
}: {
  project: Project;
  members: Member[];
  entries: TimeEntry[];
  openEntry: TimeEntry | null;
  me: string | null;
  isMember: boolean;
  isAdmin: boolean;
  canJoin: boolean;
  usedMin: number;
  pct: number;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [addOpen, setAddOpen] = useState(false);
  const [available, setAvailable] = useState<{ id: string; full_name: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState(openEntry?.description ?? "");
  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => {
    if (!openEntry) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000); void tick;
    return () => clearInterval(t);
  }, [openEntry, tick]);

  useEffect(() => {
    if (!addOpen) return;
    (async () => {
      const { data } = await supabase.from("profiles").select("id, full_name")
        .not("role", "in", PORTAL_ROLLEN_IN).eq("is_active", true).order("full_name");
      const memberIds = new Set(members.map((m) => m.user_id));
      setAvailable((data ?? []).filter((p) => !memberIds.has(p.id as string)) as { id: string; full_name: string | null }[]);
    })();
  }, [addOpen, supabase, members]);

  const nowStamping = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) if (e.clock_in && !e.clock_out) map.set(e.user_id, e.clock_in);
    return map;
  }, [entries]);

  const lastStamp = useMemo(() => {
    type Ev = { t: number; iso: string; name: string | null; action: "eingestempelt" | "ausgestempelt" };
    let best: Ev | null = null;
    for (const e of entries) {
      const name = e.user?.full_name ?? null;
      if (e.clock_in) {
        const t = new Date(e.clock_in).getTime();
        if (!best || t > best.t) best = { t, iso: e.clock_in, name, action: "eingestempelt" };
      }
      if (e.clock_out) {
        const t = new Date(e.clock_out).getTime();
        if (!best || t > best.t) best = { t, iso: e.clock_out, name, action: "ausgestempelt" };
      }
    }
    return best;
  }, [entries]);

  const budgetH = project.budget_hours ?? 0;
  const workedH = usedMin / 60;
  const budgetTone: "green" | "amber" | "red" = pct >= 100 ? "red" : pct >= 80 ? "amber" : "green";
  const toneClass: Record<typeof budgetTone, { text: string; bg: string; chipBg: string; chipText: string; border: string }> = {
    green: { text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500", chipBg: "bg-emerald-500/10", chipText: "text-emerald-700 dark:text-emerald-300", border: "border-emerald-500/40" },
    amber: { text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500", chipBg: "bg-amber-500/10", chipText: "text-amber-700 dark:text-amber-300", border: "border-amber-500/40" },
    red:   { text: "text-red-600 dark:text-red-400",     bg: "bg-red-500",     chipBg: "bg-red-500/10",   chipText: "text-red-700 dark:text-red-300",     border: "border-red-500/40"   },
  };
  const t = toneClass[budgetTone];
  const budgetLabel = budgetTone === "red" ? "aufgebraucht" : budgetTone === "amber" ? "eng" : "im Rahmen";

  async function login() {
    if (!me) return;
    setBusy(true);
    const { error } = await supabase.from("project_members").insert({ project_id: project.id, user_id: me });
    setBusy(false);
    if (error) { toast.error("Login fehlgeschlagen: " + error.message); return; }
    toast.success("Auf Projekt eingeloggt");
    onDone();
  }
  async function logout() {
    const ok = await confirm({
      title: "Vom Projekt ausloggen?",
      message: "Zeit-Einträge bleiben erhalten. Zum Stempeln müsstest du dich neu einloggen.",
      confirmLabel: "Ausloggen", variant: "red",
    });
    if (!ok || !me) return;
    setBusy(true);
    const { error } = await supabase.from("project_members").delete().eq("project_id", project.id).eq("user_id", me);
    setBusy(false);
    if (error) { toast.error("Logout fehlgeschlagen: " + error.message); return; }
    toast.success("Ausgeloggt"); onDone();
  }
  async function stampIn() {
    if (pct >= 100) return toast.error("Budget aufgebraucht.");
    if (!me) return;
    setBusy(true);
    // Konsolidierung Migration 212: Projekt-Stempel leben jetzt in
    // time_entries. Doppelstempel-Check ueber ALLE offenen Eintraege
    // (Auftrag/Projekt/Andere Arbeit) — DB-Constraint
    // time_entries_one_active_per_user haerte das ab.
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
      project_id: project.id,
      user_id: me,
      clock_in: new Date().toISOString(),
      description: note.trim() || null,
    });
    setBusy(false);
    if (error) { toast.error("Einstempeln fehlgeschlagen: " + error.message); return; }
    toast.success("Eingestempelt"); setNote(""); onDone();
  }
  async function stampOut() {
    if (!openEntry) return;
    setBusy(true);
    const { error } = await supabase.from("time_entries").update({
      clock_out: new Date().toISOString(), description: note.trim() || openEntry.description || null,
    }).eq("id", openEntry.id);
    setBusy(false);
    if (error) { toast.error("Ausstempeln fehlgeschlagen: " + error.message); return; }
    toast.success("Ausgestempelt"); onDone();
  }
  async function addMember(uid: string) {
    setBusy(true);
    const { error } = await supabase.from("project_members").insert({ project_id: project.id, user_id: uid });
    setBusy(false);
    if (error) { toast.error("Hinzufügen fehlgeschlagen: " + error.message); return; }
    toast.success("Mitglied hinzugefügt"); setAddOpen(false); onDone();
  }

  const CHF = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4">
        {/* Zeitbudget links */}
        <div>
          <div className="flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Zeitbudget</p>
          </div>
          <div className="flex items-baseline gap-2 mt-1 flex-wrap">
            <span className={cn("text-2xl font-bold tabular-nums", t.text)}>
              {workedH.toLocaleString("de-CH", { maximumFractionDigits: 1 })} h
            </span>
            <span className="text-xs text-muted-foreground">von {budgetH} h</span>
            <span className={cn("ml-auto inline-flex px-2 py-0.5 text-[10px] font-semibold rounded-full border", t.chipBg, t.chipText, t.border)}>
              {budgetLabel}
            </span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-foreground/[0.06] overflow-hidden">
            <div className={cn("h-full transition-all", t.bg)} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          {isAdmin && members.length > 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground/80 flex items-center gap-2 flex-wrap">
              {(() => {
                const nonAdminMembers = members.filter((m) => m.role !== "admin");
                const wageMembers = nonAdminMembers.filter((m) => m.hourly_wage_chf != null);
                if (wageMembers.length === 0) return <span className="italic">Kein Stundenlohn (ohne Admins) hinterlegt</span>;
                const avg = wageMembers.reduce((a, m) => a + (m.hourly_wage_chf ?? 0), 0) / wageMembers.length;
                const forecast = budgetH * avg;
                const wageByUser = new Map(nonAdminMembers.map((m) => [m.user_id, m.hourly_wage_chf ?? 0]));
                const actual = entries.reduce((a, e) => a + (e.minutes ?? 0) / 60 * (wageByUser.get(e.user_id) ?? 0), 0);
                return <>
                  Kosten: <strong className="text-foreground/80">CHF {CHF.format(actual)}</strong> / {CHF.format(forecast)} <span className="opacity-70">(Ø {CHF.format(avg)}/h · {wageMembers.length} MA)</span>
                </>;
              })()}
            </div>
          )}
        </div>

        {/* Projekt-Team rechts */}
        <div className="sm:border-l sm:pl-6">
          <div className="flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Projekt-Team</p>
            {isAdmin && (
              <button onClick={() => setAddOpen(true)} className="icon-btn p-1 rounded hover:bg-muted transition-colors" data-tooltip="Mitarbeiter hinzufügen">
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap min-h-8">
            {members.length > 0 ? members.map((m) => {
              const stampStart = nowStamping.get(m.user_id);
              const isSelf = m.user_id === me;
              const label = `${m.full_name ?? "?"}${isSelf ? " (du)" : ""}${stampStart ? " · eingestempelt" : ""}`;
              return (
                <span
                  key={m.user_id}
                  data-tooltip={label}
                  className={cn(
                    "h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-bold ring-2 cursor-default",
                    stampStart
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-500"
                      : "bg-red-500/10 text-red-700 dark:text-red-300 ring-transparent",
                  )}
                >
                  {(m.full_name ?? "?").charAt(0).toUpperCase()}
                </span>
              );
            }) : <span className="text-sm text-muted-foreground/60">Noch niemand eingeloggt.</span>}
          </div>
          {lastStamp && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Zuletzt: <span className="text-foreground font-medium">{lastStamp.name ?? "—"}</span> {lastStamp.action} · {new Date(lastStamp.iso).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
          <div className="mt-2.5 flex items-center gap-2 flex-wrap">
            {canJoin ? (
              <button onClick={login} disabled={busy} className="kasten kasten-green">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />} Einloggen
              </button>
            ) : isMember ? (
              openEntry ? (
                <button onClick={stampOut} disabled={busy} className="kasten kasten-red">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />} Ausstempeln
                </button>
              ) : (
                <button onClick={stampIn} disabled={busy || pct >= 100} className="kasten kasten-green" data-tooltip={pct >= 100 ? "Budget aufgebraucht" : undefined}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />} Einstempeln
                </button>
              )
            ) : null}
            {isMember && (
              <button onClick={logout} disabled={busy} className="kasten kasten-muted" data-tooltip="Vom Projekt ausloggen">
                <LogOut className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {openEntry && (
            <div className="mt-2">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Notiz zur laufenden Zeit (optional)" className="h-8 text-xs" />
            </div>
          )}
        </div>
      </div>

      {ConfirmModalElement}
      {addOpen && (
        <Modal open onClose={() => setAddOpen(false)} title="Mitarbeiter hinzufügen" size="md">
          <p className="text-xs text-muted-foreground mb-3">Ist danach direkt eingeloggt und kann stempeln.</p>
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Alle Mitarbeiter sind bereits eingeloggt.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto space-y-1">
              {available.map((a) => (
                <button
                  key={a.id}
                  onClick={() => addMember(a.id)}
                  disabled={busy}
                  className="w-full flex items-center gap-2 p-2 rounded-lg border border-border hover:border-emerald-300 hover:bg-emerald-50/40 dark:hover:bg-emerald-500/10 transition-colors text-left"
                >
                  <span className="h-6 w-6 rounded-full bg-foreground/10 flex items-center justify-center text-[10px] font-bold">{(a.full_name?.[0] ?? "?").toUpperCase()}</span>
                  <span className="text-sm flex-1">{a.full_name ?? "—"}</span>
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/* ============================================================
   OVERVIEW TAB (Export)
   ============================================================ */

export function OverviewTab({
  project, members, entries, appts, openEntry, me, isMember, isAdmin, canJoin,
  canEdit, canAddAppt, usedMin, pct, onReload, onOpenAppt, onOpenApptNotes,
}: {
  project: Project;
  members: Member[];
  entries: TimeEntry[];
  appts: Appointment[];
  openEntry: TimeEntry | null;
  me: string | null;
  isMember: boolean;
  isAdmin: boolean;
  canJoin: boolean;
  canEdit: boolean;
  canAddAppt: boolean;
  usedMin: number;
  pct: number;
  onReload: () => void;
  onOpenAppt: (a: Appointment | "new") => void;
  onOpenApptNotes: (a: Appointment) => void;
}) {
  return (
    <div className="space-y-4">
      {project.status === "genehmigt" && (
        <TeamBudgetPanel
          project={project}
          members={members}
          entries={entries}
          openEntry={openEntry}
          me={me}
          isMember={isMember}
          isAdmin={isAdmin}
          canJoin={canJoin}
          usedMin={usedMin}
          pct={pct}
          onDone={onReload}
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        <div className="space-y-4">
          <InfoCard project={project} canEdit={canEdit} onSaved={onReload} />
        </div>
        <div className="space-y-4">
          <AppointmentsCard
            projectId={project.id}
            appts={appts}
            canAdd={canAddAppt}
            onOpen={onOpenAppt}
            onOpenNotes={onOpenApptNotes}
            onReload={onReload}
          />
        </div>
      </div>
    </div>
  );
}
