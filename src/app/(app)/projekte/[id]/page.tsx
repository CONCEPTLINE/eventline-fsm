"use client";

/**
 * /projekte/[id] — Projekt-Detail (v2).
 *
 * Struktur:
 *   - Header: PRJ-Nummer, Titel, Status-Chip, Assignee, Vorgänger-Link
 *   - Sektions-Grid (2-spaltig auf Desktop):
 *       Links:  Ziel-Card | Notizen-Card | Termine-Card
 *       Rechts: Stempel + Fortschritt | Zeit-Einträge | Dokumente | Historie
 *   - Actions-Bar unten (Genehmigen/Ablehnen/Abschliessen/Stornieren/Budget)
 *
 * Abschluss-Flow: Klick auf Abschliessen -> Modal mit Erfolg/Misserfolg-
 * Auswahl + Notiz. Danach kann direkt ein Folgeprojekt (parent_project_id
 * vorbelegt) angelegt werden.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
import { Loading } from "@/components/ui/spinner";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import {
  Clock, CheckCircle2, XCircle, Save, Loader2, Trash2, Edit3, Paperclip,
  FileText, X, Ban, Target, StickyNote, Calendar as CalIcon, Plus,
  History, ArrowRight, ArrowLeft,
} from "lucide-react";
import { validateFileList } from "@/lib/file-upload";
import { toast } from "sonner";
import { formatHours, progressPct, progressColorClass, PROJECT_STATUS_LABEL, formatProjectNumber } from "@/lib/projekte-format";

interface Project {
  id: string;
  project_number: number | null;
  title: string;
  description: string | null;
  status: keyof typeof PROJECT_STATUS_LABEL;
  proposed_hours: number | null;
  budget_hours: number | null;
  assigned_to: string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  decision_note: string | null;
  goal_text: string | null;
  goal_date: string | null;
  notes: string | null;
  completion_success: boolean | null;
  completion_note: string | null;
  parent_project_id: string | null;
  created_at: string;
  assignee?: { full_name: string | null } | null;
  approver?: { full_name: string | null } | null;
  parent?: { id: string; project_number: number | null; title: string } | null;
}

interface TimeEntry {
  id: string;
  entry_date: string;
  minutes: number | null;
  clock_in: string | null;
  clock_out: string | null;
  description: string | null;
  user_id: string;
  created_at: string;
  user?: { full_name: string | null } | null;
}

interface Appointment {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  assigned_to: string | null;
  assignee?: { full_name: string | null } | null;
}

interface Child { id: string; project_number: number | null; title: string; status: string }

export default function ProjektDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const supabase = createClient();
  const router = useRouter();
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const { confirm, ConfirmModalElement } = useConfirm();

  const [project, setProject] = useState<Project | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [children, setChildren] = useState<Child[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decisionOpen, setDecisionOpen] = useState<"approve" | "reject" | "edit-budget" | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [apptOpen, setApptOpen] = useState<Appointment | "new" | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setMe(user?.id ?? null);
    const { data: p } = await supabase
      .from("projects")
      .select(`
        *,
        assignee:profiles!projects_assigned_to_fkey(full_name),
        approver:profiles!projects_approved_by_fkey(full_name),
        parent:parent_project_id(id, project_number, title)
      `)
      .eq("id", projectId)
      .maybeSingle();
    if (p) {
      setProject({
        ...p,
        assignee: Array.isArray(p.assignee) ? p.assignee[0] : p.assignee,
        approver: Array.isArray(p.approver) ? p.approver[0] : p.approver,
        parent: Array.isArray(p.parent) ? p.parent[0] : p.parent,
      } as Project);
    }
    const [entriesRes, apptsRes, childrenRes] = await Promise.all([
      supabase
        .from("project_time_entries")
        .select("id, entry_date, minutes, clock_in, clock_out, description, user_id, created_at, user:profiles!project_time_entries_user_id_fkey(full_name)")
        .eq("project_id", projectId)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase
        .from("project_appointments")
        .select("id, title, description, start_time, end_time, assigned_to, assignee:profiles!project_appointments_assigned_to_fkey(full_name)")
        .eq("project_id", projectId)
        .order("start_time", { ascending: true }),
      supabase
        .from("projects")
        .select("id, project_number, title, status")
        .eq("parent_project_id", projectId)
        .eq("is_deleted", false)
        .order("created_at", { ascending: true }),
    ]);
    setEntries((entriesRes.data ?? []).map((e) => ({ ...e, user: Array.isArray(e.user) ? e.user[0] : e.user })) as TimeEntry[]);
    setAppts((apptsRes.data ?? []).map((a) => ({ ...a, assignee: Array.isArray(a.assignee) ? a.assignee[0] : a.assignee })) as Appointment[]);
    setChildren((childrenRes.data ?? []) as Child[]);
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading />;
  if (!project) return <div className="text-sm text-muted-foreground">Projekt nicht gefunden.</div>;

  const status = PROJECT_STATUS_LABEL[project.status];
  const usedMin = entries.reduce((a, e) => a + (e.minutes ?? 0), 0);
  const openEntry = entries.find((e) => e.clock_in && !e.clock_out && e.user_id === me);
  const pct = progressPct(usedMin, project.budget_hours);
  const remainingH = project.budget_hours != null ? Math.max(0, project.budget_hours - usedMin / 60) : null;
  const canStamp = me === project.assigned_to && project.status === "genehmigt";
  const canApprove = isAdmin && project.status === "angefragt";
  const canClose = isAdmin && project.status === "genehmigt";
  const isArchived = project.status === "storniert" || project.status === "abgeschlossen" || project.status === "abgelehnt";
  const canCancel = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by);
  const canEditText = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by);
  const canAddAppt = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by);

  async function deleteProject() {
    const ok = await confirm({
      title: "Projekt löschen?",
      message: "Das Projekt wird als gelöscht markiert. Zeit-Einträge bleiben in der Historie erhalten.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("projects").update({ is_deleted: true }).eq("id", projectId);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    toast.success("Projekt gelöscht");
    router.push("/projekte");
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-start gap-2">
        <BackButton fallbackHref="/projekte" size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-foreground/[0.06] text-[11px] font-mono font-semibold tabular-nums">
              {formatProjectNumber(project.project_number)}
            </span>
            <h1 className="text-xl font-semibold truncate">{project.title}</h1>
            <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${status.color}`}>
              {status.label}
            </span>
            {project.completion_success === true && (
              <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">
                Erfolgreich
              </span>
            )}
            {project.completion_success === false && (
              <span className="inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300">
                Nicht erfolgreich
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {project.assignee?.full_name ?? "—"} · angelegt {new Date(project.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
            {project.parent && (
              <> · <ArrowLeft className="inline h-3 w-3" /> aus <Link href={`/projekte/${project.parent.id}`} className="underline hover:text-foreground">{formatProjectNumber(project.parent.project_number)}</Link></>
            )}
          </p>
        </div>
        {isAdmin && (
          <button onClick={deleteProject} className="kasten kasten-muted" data-tooltip="Projekt löschen">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Stempeln (top-priorität wenn genehmigt + assigned) */}
      {canStamp && (
        <StampControl
          projectId={project.id}
          openEntry={openEntry ?? null}
          budgetAufgebraucht={pct >= 100}
          onDone={load}
        />
      )}

      {/* Zwei-Spalten-Grid auf Desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* LINKS: Ziel / Notizen / Termine / Historie */}
        <div className="space-y-4">
          <GoalCard project={project} canEdit={canEditText} onSaved={load} />
          <NotesCard project={project} canEdit={canEditText} onSaved={load} />
          <AppointmentsCard
            projectId={project.id}
            appts={appts}
            canAdd={canAddAppt}
            onOpen={setApptOpen}
            onReload={load}
          />
          {(project.parent || children.length > 0 || project.status === "abgeschlossen") && (
            <HistoryCard project={project} children_={children} />
          )}
        </div>

        {/* RECHTS: Budget/Fortschritt / Zeit-Einträge / Dokumente */}
        <div className="space-y-4">
          <BudgetCard project={project} usedMin={usedMin} pct={pct} remainingH={remainingH} />
          <TimeEntriesCard entries={entries} isAdmin={isAdmin} />
          <ProjectDocuments projectId={project.id} isAdmin={isAdmin} canUpload={canEditText} />
        </div>
      </div>

      {/* Actions-Bar unten */}
      {(canApprove || canClose || canCancel) && (
        <div className="sticky bottom-2 z-10 bg-card border rounded-xl p-2 flex gap-2 flex-wrap shadow-sm">
          <div className="text-[10px] text-muted-foreground/70 self-center px-1">Aktionen:</div>
          {canApprove && (
            <>
              <button onClick={() => setDecisionOpen("approve")} className="kasten kasten-green">
                <CheckCircle2 className="h-3.5 w-3.5" /> Genehmigen
              </button>
              <button onClick={() => setDecisionOpen("reject")} className="kasten kasten-red">
                <XCircle className="h-3.5 w-3.5" /> Ablehnen
              </button>
            </>
          )}
          {canClose && (
            <>
              <button onClick={() => setDecisionOpen("edit-budget")} className="kasten kasten-muted">
                <Edit3 className="h-3.5 w-3.5" /> Budget
              </button>
              <button onClick={() => setCloseOpen(true)} className="kasten kasten-blue">
                <CheckCircle2 className="h-3.5 w-3.5" /> Abschließen
              </button>
            </>
          )}
          {canCancel && (
            <button onClick={() => setCancelOpen(true)} className="kasten kasten-red ml-auto">
              <Ban className="h-3.5 w-3.5" /> Stornieren
            </button>
          )}
        </div>
      )}

      {/* Folgeprojekt-Button bei abgeschlossenen */}
      {isArchived && (isAdmin || me === project.assigned_to || me === project.created_by) && (
        <div className="flex justify-center">
          <button
            onClick={() => router.push(`/projekte/neu?parent=${project.id}`)}
            className="kasten kasten-purple"
          >
            <ArrowRight className="h-3.5 w-3.5" /> Folgeprojekt erstellen
          </button>
        </div>
      )}

      {decisionOpen && <DecisionModal mode={decisionOpen} project={project} onClose={() => setDecisionOpen(null)} onDone={() => { setDecisionOpen(null); load(); }} />}
      {cancelOpen && <CancelModal projectId={project.id} onClose={() => setCancelOpen(false)} onDone={() => { setCancelOpen(false); load(); }} />}
      {closeOpen && <CloseModal projectId={project.id} onClose={() => setCloseOpen(false)} onDone={() => { setCloseOpen(false); load(); }} />}
      {apptOpen && (
        <AppointmentModal
          projectId={project.id}
          initial={apptOpen === "new" ? null : apptOpen}
          onClose={() => setApptOpen(null)}
          onDone={() => { setApptOpen(null); load(); }}
        />
      )}
      {ConfirmModalElement}
    </div>
  );
}

/* ============================================================
   SECTIONS
   ============================================================ */

function GoalCard({ project, canEdit, onSaved }: { project: Project; canEdit: boolean; onSaved: () => void }) {
  const supabase = createClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(project.goal_text ?? "");
  const [date, setDate] = useState(project.goal_date ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("projects")
      .update({ goal_text: text.trim() || null, goal_date: date || null })
      .eq("id", project.id);
    setSaving(false);
    if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    setEditing(false);
    onSaved();
  }

  const daysToGoal = useMemo(() => {
    if (!date) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(date + "T12:00:00");
    return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  }, [date]);

  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">Ziel</p>
          {canEdit && !editing && (
            <button onClick={() => setEditing(true)} className="kasten kasten-muted text-[11px] py-1 px-2">
              <Edit3 className="h-3 w-3" />
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder="Was soll konkret erreicht werden?"
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground/70">Bis:</span>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8 max-w-40" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setEditing(false); setText(project.goal_text ?? ""); setDate(project.goal_date ?? ""); }} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
              <button onClick={save} disabled={saving} className="kasten kasten-red flex-1">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Speichern
              </button>
            </div>
          </div>
        ) : project.goal_text || project.goal_date ? (
          <div>
            {project.goal_text && <p className="text-sm whitespace-pre-wrap">{project.goal_text}</p>}
            {project.goal_date && (
              <p className="text-[11px] text-muted-foreground mt-2">
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
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">Kein Ziel definiert. {canEdit && "Klick oben rechts zum Setzen."}</p>
        )}
      </CardContent>
    </Card>
  );
}

function NotesCard({ project, canEdit, onSaved }: { project: Project; canEdit: boolean; onSaved: () => void }) {
  const supabase = createClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(project.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const { error } = await supabase.from("projects").update({ notes: text.trim() || null }).eq("id", project.id);
    setSaving(false);
    if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    setEditing(false);
    onSaved();
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <StickyNote className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">Notizen</p>
          {canEdit && !editing && (
            <button onClick={() => setEditing(true)} className="kasten kasten-muted text-[11px] py-1 px-2">
              <Edit3 className="h-3 w-3" />
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder="Gedanken, Ideen, Zwischenstände, Kontakte…"
              className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-y focus:outline-none focus:ring-2 focus:ring-ring/40"
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={() => { setEditing(false); setText(project.notes ?? ""); }} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
              <button onClick={save} disabled={saving} className="kasten kasten-red flex-1">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Speichern
              </button>
            </div>
          </div>
        ) : project.notes ? (
          <p className="text-sm whitespace-pre-wrap">{project.notes}</p>
        ) : (
          <p className="text-xs text-muted-foreground italic">Noch keine Notizen. {canEdit && "Klick oben rechts zum Schreiben."}</p>
        )}
      </CardContent>
    </Card>
  );
}

function AppointmentsCard({ projectId, appts, canAdd, onOpen, onReload }: {
  projectId: string;
  appts: Appointment[];
  canAdd: boolean;
  onOpen: (a: Appointment | "new") => void;
  onReload: () => void;
}) {
  const supabase = createClient();
  async function del(id: string) {
    if (!confirm("Termin löschen?")) return;
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
              <div key={a.id} className="flex items-center gap-2 p-2 rounded-lg bg-muted/20 text-sm">
                <CalIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{a.title}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {new Date(a.start_time).toLocaleString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    {a.end_time && ` – ${new Date(a.end_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}`}
                    {a.assignee?.full_name && ` · ${a.assignee.full_name}`}
                  </div>
                </div>
                {canAdd && (
                  <>
                    <button onClick={() => onOpen(a)} className="text-muted-foreground hover:text-foreground shrink-0"><Edit3 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => del(a.id)} className="text-muted-foreground hover:text-destructive shrink-0"><X className="h-3.5 w-3.5" /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BudgetCard({ project, usedMin, pct, remainingH }: { project: Project; usedMin: number; pct: number; remainingH: number | null }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {project.description && (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{project.description}</p>
        )}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-muted-foreground/70">Vorschlag</p>
            <p className="font-medium">{project.proposed_hours != null ? `${project.proposed_hours.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h` : "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground/70">Genehmigt</p>
            <p className="font-medium">{project.budget_hours != null ? `${project.budget_hours.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h` : "— (offen)"}</p>
          </div>
        </div>
        {project.budget_hours != null && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Verbraucht: {formatHours(usedMin)}</span>
              <span>Übrig: {remainingH != null ? `${remainingH.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h` : "—"}</span>
            </div>
            <div className="h-2 rounded-full bg-foreground/[0.08] overflow-hidden">
              <div className={`h-full ${progressColorClass(pct)} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            {pct >= 100 && <p className="text-[11px] text-red-600 dark:text-red-400 font-medium">Budget aufgebraucht.</p>}
            {pct >= 80 && pct < 100 && <p className="text-[11px] text-amber-600 dark:text-amber-400">{Math.round(pct)}% verbraucht.</p>}
          </div>
        )}
        {project.decision_note && (
          <div className="mt-2 p-2 rounded-lg bg-muted/40 text-[11px]">
            <p className="text-muted-foreground/70 mb-0.5">Kommentar:</p>
            <p>{project.decision_note}</p>
            {project.approver?.full_name && project.approved_at && (
              <p className="text-muted-foreground/70 mt-1">
                {project.approver.full_name} · {new Date(project.approved_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}
              </p>
            )}
          </div>
        )}
        {project.completion_note && (
          <div className="mt-2 p-2 rounded-lg bg-muted/40 text-[11px]">
            <p className="text-muted-foreground/70 mb-0.5">Abschluss-Notiz:</p>
            <p>{project.completion_note}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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
          <div className="space-y-1 max-h-96 overflow-y-auto">
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

function HistoryCard({ project, children_ }: { project: Project; children_: Child[] }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Historie</p>
        </div>
        {project.parent && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/20 text-sm">
            <ArrowLeft className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-muted-foreground">Vorgänger</p>
              <Link href={`/projekte/${project.parent.id}`} className="font-medium truncate hover:underline">
                {formatProjectNumber(project.parent.project_number)} · {project.parent.title}
              </Link>
            </div>
          </div>
        )}
        {children_.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground">Folgeprojekte:</p>
            {children_.map((c) => {
              const s = PROJECT_STATUS_LABEL[c.status];
              return (
                <Link key={c.id} href={`/projekte/${c.id}`} className="flex items-center gap-2 p-2 rounded-lg bg-muted/20 text-sm hover:bg-muted/40 transition-colors">
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-[10px] text-muted-foreground">{formatProjectNumber(c.project_number)}</span>
                    <span className="mx-1">·</span>
                    <span className="font-medium">{c.title}</span>
                  </span>
                  <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${s?.color ?? ""}`}>{s?.label ?? c.status}</span>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   STAMPING
   ============================================================ */

function StampControl({ projectId, openEntry, budgetAufgebraucht, onDone }: {
  projectId: string;
  openEntry: TimeEntry | null;
  budgetAufgebraucht: boolean;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(openEntry?.description ?? "");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!openEntry) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [openEntry]);

  async function stampIn() {
    if (budgetAufgebraucht) return toast.error("Budget aufgebraucht.");
    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBusy(false); return; }
    const { data: existing } = await supabase
      .from("project_time_entries")
      .select("id")
      .eq("user_id", user.id)
      .is("clock_out", null)
      .maybeSingle();
    if (existing) {
      setBusy(false);
      toast.error("Du bist bereits auf einem anderen Projekt eingestempelt.");
      return;
    }
    const { error } = await supabase.from("project_time_entries").insert({
      project_id: projectId, user_id: user.id, clock_in: new Date().toISOString(), description: note.trim() || null,
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
    const { error } = await supabase
      .from("project_time_entries")
      .update({ clock_out: new Date().toISOString(), description: note.trim() || openEntry.description || null })
      .eq("id", openEntry.id);
    setBusy(false);
    if (error) { toast.error("Ausstempeln fehlgeschlagen: " + error.message); return; }
    toast.success("Ausgestempelt");
    onDone();
  }

  if (openEntry) {
    const startMs = new Date(openEntry.clock_in!).getTime();
    const elapsed = Math.max(0, Date.now() - startMs);
    const h = Math.floor(elapsed / 3600000), m = Math.floor((elapsed % 3600000) / 60000), s = Math.floor((elapsed % 60000) / 1000);
    void tick;
    return (
      <div className="rounded-xl border-2 border-green-500/60 bg-green-500/5 p-4 flex items-center gap-4">
        <div className="h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse" />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-400">Eingestempelt seit {new Date(openEntry.clock_in!).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}</p>
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
    <div className="rounded-xl border bg-card p-4 flex items-center gap-3">
      <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Woran arbeitest du? (optional)" className="flex-1" />
      <button onClick={stampIn} disabled={busy || budgetAufgebraucht} className="kasten kasten-green shrink-0" data-tooltip={budgetAufgebraucht ? "Budget aufgebraucht" : undefined}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
        {budgetAufgebraucht ? "Budget aufgebraucht" : "Einstempeln"}
      </button>
    </div>
  );
}

/* ============================================================
   MODALS
   ============================================================ */

function DecisionModal({ mode, project, onClose, onDone }: {
  mode: "approve" | "reject" | "edit-budget";
  project: Project;
  onClose: () => void;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [budget, setBudget] = useState(
    mode === "approve" ? (project.proposed_hours?.toString() ?? "") : mode === "edit-budget" ? (project.budget_hours?.toString() ?? "") : "",
  );
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const title = mode === "approve" ? "Projekt genehmigen" : mode === "reject" ? "Projekt ablehnen" : "Budget anpassen";

  async function submit() {
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (mode === "reject") {
      const { error } = await supabase.from("projects").update({
        status: "abgelehnt", approved_by: user?.id ?? null, approved_at: new Date().toISOString(), decision_note: note.trim() || null,
      }).eq("id", project.id);
      setSaving(false);
      if (error) { toast.error("Ablehnen fehlgeschlagen: " + error.message); return; }
      toast.success("Projekt abgelehnt");
      onDone(); return;
    }
    const b = parseFloat(budget.replace(",", "."));
    if (!Number.isFinite(b) || b <= 0) { toast.error("Bitte Budget-Stunden angeben"); setSaving(false); return; }
    const payload: Record<string, unknown> = { budget_hours: b };
    if (mode === "approve") { payload.status = "genehmigt"; payload.approved_by = user?.id ?? null; payload.approved_at = new Date().toISOString(); }
    if (note.trim()) payload.decision_note = note.trim();
    const { error } = await supabase.from("projects").update(payload).eq("id", project.id);
    setSaving(false);
    if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    toast.success(mode === "approve" ? "Projekt genehmigt" : "Budget aktualisiert");
    onDone();
  }

  return (
    <Modal open onClose={onClose} title={title} size="md">
      <div className="space-y-3">
        {mode !== "reject" && (
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Budget in Stunden {project.proposed_hours != null && mode === "approve" && `(Vorschlag: ${project.proposed_hours})`}</p>
            <Input type="text" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} autoFocus />
          </div>
        )}
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground/70 ml-1">Kommentar {mode === "reject" && "(empfohlen)"}</p>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40" placeholder={mode === "reject" ? "Warum wird abgelehnt?" : "Optional"} />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button onClick={submit} disabled={saving} className={`flex-1 kasten ${mode === "reject" ? "kasten-red" : mode === "approve" ? "kasten-green" : "kasten-red"}`}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : mode === "approve" ? <CheckCircle2 className="h-3.5 w-3.5" /> : mode === "reject" ? <XCircle className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "…" : mode === "approve" ? "Genehmigen" : mode === "reject" ? "Ablehnen" : "Speichern"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CancelModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const supabase = createClient();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit() {
    if (!reason.trim()) return toast.error("Begründung ist Pflicht");
    setSaving(true);
    const { error } = await supabase.rpc("cancel_project", { p_project_id: projectId, p_reason: reason.trim() });
    setSaving(false);
    if (error) { toast.error("Stornieren fehlgeschlagen: " + error.message); return; }
    toast.success("Projekt storniert");
    onDone();
  }
  return (
    <Modal open onClose={onClose} title="Projekt stornieren" size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">Wird als storniert ins Archiv verschoben. Zeit-Einträge bleiben.</p>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Begründung *</p>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} autoFocus className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40" placeholder="Warum wird das Projekt storniert?" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button onClick={submit} disabled={saving || !reason.trim()} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
            {saving ? "…" : "Stornieren"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CloseModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const supabase = createClient();
  const [success, setSuccess] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (success === null) return toast.error("Bitte Erfolg oder Nicht-Erfolg wählen");
    setSaving(true);
    const { error } = await supabase.from("projects").update({
      status: "abgeschlossen",
      completion_success: success,
      completion_note: note.trim() || null,
    }).eq("id", projectId);
    setSaving(false);
    if (error) { toast.error("Abschluss fehlgeschlagen: " + error.message); return; }
    toast.success(success ? "Erfolgreich abgeschlossen" : "Als nicht erfolgreich abgeschlossen");
    onDone();
  }

  return (
    <Modal open onClose={onClose} title="Projekt abschließen" size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Nach dem Abschluss kann keine Zeit mehr gebucht werden. Danach kannst du ein Folgeprojekt anlegen.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setSuccess(true)}
            className={success === true ? "kasten-active" : "kasten-toggle-off"}
          >
            <CheckCircle2 className="h-3.5 w-3.5" /> Erfolgreich
          </button>
          <button
            type="button"
            onClick={() => setSuccess(false)}
            className={success === false ? "kasten-active" : "kasten-toggle-off"}
          >
            <XCircle className="h-3.5 w-3.5" /> Nicht erfolgreich
          </button>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Abschluss-Kommentar</p>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40" placeholder="Was ist das Ergebnis? Was wurde erreicht / verpasst?" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button onClick={submit} disabled={saving || success === null} className="kasten kasten-blue flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {saving ? "…" : "Abschließen"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AppointmentModal({ projectId, initial, onClose, onDone }: {
  projectId: string;
  initial: Appointment | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const startInit = initial?.start_time ? toLocalInput(initial.start_time) : "";
  const endInit = initial?.end_time ? toLocalInput(initial.end_time) : "";
  const [start, setStart] = useState(startInit);
  const [end, setEnd] = useState(endInit);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim()) return toast.error("Titel ist Pflicht");
    if (!start) return toast.error("Startzeit ist Pflicht");
    const startIso = new Date(start).toISOString();
    const endIso = end ? new Date(end).toISOString() : null;
    if (endIso && endIso <= startIso) return toast.error("Ende muss nach Start liegen");

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (initial) {
      const { error } = await supabase.from("project_appointments").update({
        title: title.trim(), description: description.trim() || null, start_time: startIso, end_time: endIso,
      }).eq("id", initial.id);
      setSaving(false);
      if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    } else {
      const { error } = await supabase.from("project_appointments").insert({
        project_id: projectId, title: title.trim(), description: description.trim() || null,
        start_time: startIso, end_time: endIso, created_by: user?.id, assigned_to: user?.id ?? null,
      });
      setSaving(false);
      if (error) { toast.error("Erstellen fehlgeschlagen: " + error.message); return; }
    }
    toast.success(initial ? "Termin aktualisiert" : "Termin erstellt");
    onDone();
  }

  return (
    <Modal open onClose={onClose} title={initial ? "Termin bearbeiten" : "Neuer Termin"} size="md">
      <div className="space-y-3">
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Titel *</p>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="z.B. Vor-Ort-Termin" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Start *</p>
            <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ende</p>
            <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Notiz</p>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40" />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button onClick={submit} disabled={saving} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "…" : "Speichern"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

/* ============================================================
   DOCUMENTS
   ============================================================ */

interface DocRow {
  id: string;
  name: string;
  storage_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
  uploaded_by: string;
  uploader?: { full_name: string | null } | null;
}

function ProjectDocuments({ projectId, isAdmin, canUpload }: { projectId: string; isAdmin: boolean; canUpload: boolean }) {
  const supabase = createClient();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [me, setMe] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setMe(user?.id ?? null);
    const { data } = await supabase
      .from("documents")
      .select("id, name, storage_path, file_size, mime_type, created_at, uploaded_by, uploader:profiles!documents_uploaded_by_fkey(full_name)")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    setDocs((data ?? []).map((d) => ({ ...d, uploader: Array.isArray(d.uploader) ? d.uploader[0] : d.uploader })) as DocRow[]);
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const validated = validateFileList(files);
    if (!validated) return;
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setUploading(false); return; }
    let ok = 0, fail = 0;
    for (const file of validated) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `projekte/${projectId}/${Date.now()}_${safeName}`;
      try {
        const fd = new FormData(); fd.append("file", file); fd.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const j = await res.json();
        if (!j.success) { fail++; continue; }
        const { error } = await supabase.from("documents").insert({
          name: file.name, storage_path: path, file_size: file.size, mime_type: file.type,
          project_id: projectId, uploaded_by: user.id,
        });
        if (error) fail++; else ok++;
      } catch { fail++; }
    }
    setUploading(false);
    if (ok > 0) toast.success(`${ok} Datei(en) hochgeladen`);
    if (fail > 0) toast.error(`${fail} Datei(en) fehlgeschlagen`);
    load();
  }

  async function openDoc(doc: DocRow) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 300);
    if (error || !data) { toast.error("Link konnte nicht generiert werden"); return; }
    window.open(data.signedUrl, "_blank");
  }

  async function deleteDoc(doc: DocRow) {
    if (!confirm(`Dokument "${doc.name}" löschen?`)) return;
    await supabase.storage.from("documents").remove([doc.storage_path]);
    const { error } = await supabase.from("documents").delete().eq("id", doc.id);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    toast.success("Gelöscht");
    load();
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">Dokumente ({docs.length})</p>
        </div>
        {canUpload && (
          <label className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed bg-muted/20 text-sm text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors cursor-pointer">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            {uploading ? "Lädt hoch…" : "Dateien auswählen…"}
            <input type="file" multiple className="sr-only" disabled={uploading} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
          </label>
        )}
        {loading ? (
          <p className="text-xs text-muted-foreground italic">Lädt…</p>
        ) : docs.length === 0 ? (
          !canUpload && <p className="text-xs text-muted-foreground italic">Keine Dokumente.</p>
        ) : (
          <div className="space-y-1">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/20 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <button onClick={() => openDoc(d)} className="flex-1 min-w-0 text-left hover:underline">
                  <span className="block truncate">{d.name}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {d.file_size ? `${(d.file_size / 1024).toFixed(0)} KB · ` : ""}
                    {d.uploader?.full_name ?? "—"} · {new Date(d.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                  </span>
                </button>
                {(isAdmin || me === d.uploaded_by) && (
                  <button onClick={() => deleteDoc(d)} className="text-muted-foreground hover:text-destructive shrink-0" aria-label="Löschen">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
