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
  History, ArrowRight, ArrowLeft, LogIn, LogOut, Users, DollarSign, Send,
  MessageSquare, Eye, Download,
} from "lucide-react";
import { validateFileList } from "@/lib/file-upload";
import { toast } from "sonner";
import { formatHours, progressPct, progressColorClass, PROJECT_STATUS_LABEL, formatProjectNumber } from "@/lib/projekte-format";
import { cn } from "@/lib/utils";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { MultiPicker, type MultiPickerItem } from "@/components/ui/multi-picker";

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

interface AppointmentParticipant {
  id: string;
  profile_id: string | null;
  customer_id: string | null;
  name: string;
}

interface Appointment {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  assigned_to: string | null;
  assignee?: { full_name: string | null } | null;
  participants: AppointmentParticipant[];
  notesCount: number;
}

interface Child { id: string; project_number: number | null; title: string; status: string }
interface Member { user_id: string; joined_at: string; full_name: string | null; role: string | null; hourly_wage_chf: number | null }
interface AuditEntry { id: string; kind: string; old_value: string | null; new_value: string | null; reason: string | null; created_at: string; changer?: { full_name: string | null } | null }

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
  const [members, setMembers] = useState<Member[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decisionOpen, setDecisionOpen] = useState<"approve" | "reject" | "edit-budget" | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [apptOpen, setApptOpen] = useState<Appointment | "new" | null>(null);
  const [notesModalAppt, setNotesModalAppt] = useState<Appointment | null>(null);

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
    const [entriesRes, apptsRes, childrenRes, membersRes, auditRes] = await Promise.all([
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
      supabase
        .from("project_members")
        .select("user_id, joined_at, member:profiles!project_members_user_id_fkey(full_name, role)")
        .eq("project_id", projectId)
        .order("joined_at", { ascending: true }),
      supabase
        .from("project_audit")
        .select("id, kind, old_value, new_value, reason, created_at, changer:profiles!project_audit_changed_by_fkey(full_name)")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
    ]);
    setEntries((entriesRes.data ?? []).map((e) => ({ ...e, user: Array.isArray(e.user) ? e.user[0] : e.user })) as TimeEntry[]);

    // Termine + Teilnehmer + Notiz-Count in einem Rutsch: erst appointments,
    // dann alle participants & note-counts in je EINER query, dann pro Appt gruppieren.
    const apptsBase = (apptsRes.data ?? []).map((a) => ({
      ...a,
      assignee: Array.isArray(a.assignee) ? a.assignee[0] : a.assignee,
    })) as Array<Omit<Appointment, "participants" | "notesCount">>;
    const apptIds = apptsBase.map((a) => a.id);
    const participantsByAppt = new Map<string, AppointmentParticipant[]>();
    const notesCountByAppt = new Map<string, number>();
    if (apptIds.length > 0) {
      const [partsRes, notesRes] = await Promise.all([
        supabase
          .from("project_appointment_participants")
          .select("id, appointment_id, profile_id, customer_id, profile:profile_id(full_name), customer:customer_id(name)")
          .in("appointment_id", apptIds),
        supabase
          .from("project_appointment_notes")
          .select("appointment_id")
          .in("appointment_id", apptIds),
      ]);
      for (const p of (partsRes.data ?? []) as Array<{
        id: string;
        appointment_id: string;
        profile_id: string | null;
        customer_id: string | null;
        profile: { full_name: string | null } | { full_name: string | null }[] | null;
        customer: { name: string | null } | { name: string | null }[] | null;
      }>) {
        const prof = Array.isArray(p.profile) ? p.profile[0] : p.profile;
        const cust = Array.isArray(p.customer) ? p.customer[0] : p.customer;
        const name = prof?.full_name ?? cust?.name ?? "?";
        const list = participantsByAppt.get(p.appointment_id) ?? [];
        list.push({ id: p.id, profile_id: p.profile_id, customer_id: p.customer_id, name });
        participantsByAppt.set(p.appointment_id, list);
      }
      for (const n of (notesRes.data ?? []) as Array<{ appointment_id: string }>) {
        notesCountByAppt.set(n.appointment_id, (notesCountByAppt.get(n.appointment_id) ?? 0) + 1);
      }
    }
    setAppts(apptsBase.map((a) => ({
      ...a,
      participants: participantsByAppt.get(a.id) ?? [],
      notesCount: notesCountByAppt.get(a.id) ?? 0,
    })));
    setChildren((childrenRes.data ?? []) as Child[]);

    // Members mit Stundenlohn (fuer Kosten-Prognose beim Admin).
    const memberList = (membersRes.data ?? []).map((m) => ({
      user_id: m.user_id as string,
      joined_at: m.joined_at as string,
      member: Array.isArray(m.member) ? m.member[0] : m.member,
    }));
    const uids = memberList.map((m) => m.user_id);
    const wageMap = new Map<string, number>();
    if (uids.length > 0) {
      const { data: comps } = await supabase
        .from("employee_compensation")
        .select("profile_id, hourly_wage_chf")
        .in("profile_id", uids)
        .is("effective_to", null);
      for (const c of comps ?? []) wageMap.set(c.profile_id as string, Number(c.hourly_wage_chf));
    }
    setMembers(memberList.map((m) => {
      const member = m.member as { full_name: string | null; role: string | null } | null;
      return {
        user_id: m.user_id,
        joined_at: m.joined_at,
        full_name: member?.full_name ?? null,
        role: member?.role ?? null,
        hourly_wage_chf: wageMap.get(m.user_id) ?? null,
      };
    }));
    setAudit((auditRes.data ?? []).map((a) => ({ ...a, changer: Array.isArray(a.changer) ? a.changer[0] : a.changer })) as AuditEntry[]);
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading />;
  if (!project) return <div className="text-sm text-muted-foreground">Projekt nicht gefunden.</div>;

  const status = PROJECT_STATUS_LABEL[project.status];
  const usedMin = entries.reduce((a, e) => a + (e.minutes ?? 0), 0);
  const openEntry = entries.find((e) => e.clock_in && !e.clock_out && e.user_id === me);
  const pct = progressPct(usedMin, project.budget_hours);
  // remainingH wurde von BudgetCard genutzt (jetzt im TeamBudgetPanel drin)
  const isMember = !!me && members.some((m) => m.user_id === me);
  const canStamp = isMember && project.status === "genehmigt";
  const canJoin = !isMember && !!me && project.status === "genehmigt";
  const canApprove = isAdmin && project.status === "angefragt";
  const canClose = isAdmin && project.status === "genehmigt";
  const canSubmitDraft = project.status === "entwurf" && (me === project.assigned_to || me === project.created_by);
  const isArchived = project.status === "storniert" || project.status === "abgeschlossen" || project.status === "abgelehnt";
  const canCancel = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by);
  const canEditText = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by);
  const canAddAppt = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by || isMember);

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

      {/* Zeitbudget + Projekt-Team in EINEM Panel (analog conceptline) */}
      {project.status === "genehmigt" && (
        <TeamBudgetPanel
          project={project}
          members={members}
          entries={entries}
          openEntry={openEntry ?? null}
          me={me}
          isMember={isMember}
          isAdmin={isAdmin}
          canJoin={canJoin}
          usedMin={usedMin}
          pct={pct}
          onDone={load}
        />
      )}

      {/* 2-Spalten-Layout — jede Kolonne stapelt separat. Wenn eine Card
          wächst (z.B. Info-Bearbeitung), shiftet nur die eigene Kolonne
          nach unten; die andere bleibt an Ort und Stelle. Der User
          empfindet das nicht als "einzelne Blöcke die rumzappen". */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        {/* LINKS: Info + Termine */}
        <div className="space-y-4">
          <InfoCard project={project} canEdit={canEditText} onSaved={load} />
          <AppointmentsCard
            projectId={project.id}
            appts={appts}
            canAdd={canAddAppt}
            onOpen={setApptOpen}
            onOpenNotes={setNotesModalAppt}
            onReload={load}
          />
        </div>

        {/* RECHTS: Zeit-Einträge + Dokumente */}
        <div className="space-y-4">
          <TimeEntriesCard entries={entries} isAdmin={isAdmin} />
          <ProjectDocuments projectId={project.id} isAdmin={isAdmin} canUpload={canEditText} />
        </div>
      </div>

      {/* Historie full-width unten — inkl. Genehmigungs-Kommentar / Abschluss-Notiz. */}
      {(project.parent || children.length > 0 || audit.length > 0 || project.decision_note || project.completion_note) && (
        <HistoryCard project={project} children_={children} audit={audit} />
      )}

      {/* Actions-Bar unten */}
      {(canApprove || canClose || canCancel || canSubmitDraft) && (
        <div className="sticky bottom-2 z-10 bg-card border rounded-xl p-2 flex gap-2 flex-wrap shadow-sm">
          <div className="text-[10px] text-muted-foreground/70 self-center px-1">Aktionen:</div>
          {canSubmitDraft && (
            <button
              onClick={async () => {
                const { error } = await supabase.from("projects").update({ status: "angefragt" }).eq("id", project.id);
                if (error) { toast.error("Einreichen fehlgeschlagen: " + error.message); return; }
                toast.success("Zur Genehmigung eingereicht");
                load();
              }}
              className="kasten kasten-red"
            >
              <Send className="h-3.5 w-3.5" /> Einreichen
            </button>
          )}
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
      {notesModalAppt && (
        <AppointmentNotesModal
          appointmentId={notesModalAppt.id}
          appointmentTitle={notesModalAppt.title}
          me={me}
          isAdmin={isAdmin}
          onClose={() => setNotesModalAppt(null)}
          onChanged={load}
        />
      )}
      {ConfirmModalElement}
    </div>
  );
}

/* ============================================================
   SECTIONS
   ============================================================ */

/** InfoCard — konsolidierte Info-Sektion: Ziel, Beschreibung, Notizen.
 *  Alles in einer Card mit klaren Sub-Sections. Edit-in-place fuer den
 *  ganzen Block, damit nicht bei jedem Feld die Card wackelt. */
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
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{project.description}</p>
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

function BudgetCard({ project, usedMin, pct, remainingH, costs }: {
  project: Project;
  usedMin: number;
  pct: number;
  remainingH: number | null;
  costs: { members: Member[]; entries: TimeEntry[] } | null;
}) {
  const CHFFmt = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const wagesAvailable = costs ? costs.members.filter((m) => m.hourly_wage_chf != null) : [];
  const avgWage = wagesAvailable.length > 0
    ? wagesAvailable.reduce((a, m) => a + (m.hourly_wage_chf ?? 0), 0) / wagesAvailable.length
    : null;
  const forecastChf = avgWage != null && project.budget_hours != null && project.budget_hours > 0
    ? avgWage * project.budget_hours : null;
  const wageByUser = costs ? new Map(costs.members.map((m) => [m.user_id, m.hourly_wage_chf ?? 0])) : new Map<string, number>();
  const actualChf = costs
    ? costs.entries.reduce((a, e) => a + (e.minutes ?? 0) / 60 * (wageByUser.get(e.user_id) ?? 0), 0)
    : 0;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
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
        {/* Kosten-Prognose direkt integriert (nur Admin) */}
        {costs && (
          <div className="mt-2 pt-3 border-t border-border/60">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
              <DollarSign className="h-3 w-3" /> Kosten (nur Admin)
            </p>
            {costs.members.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">Sobald Mitarbeiter einloggen, wird die Prognose berechnet.</p>
            ) : avgWage == null ? (
              <p className="text-[11px] text-muted-foreground italic">Kein Stundenlohn bei den Mitgliedern hinterlegt.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">Ø Lohn ({wagesAvailable.length} MA)</span>
                <span className="tabular-nums text-right">CHF {CHFFmt.format(avgWage)}/h</span>
                {forecastChf != null && (<>
                  <span className="text-muted-foreground">Prognose</span>
                  <span className="tabular-nums text-right font-semibold">CHF {CHFFmt.format(forecastChf)}</span>
                </>)}
                <span className="text-muted-foreground">Ist</span>
                <span className="tabular-nums text-right">CHF {CHFFmt.format(actualChf)}</span>
                {forecastChf != null && (<>
                  <span className="text-muted-foreground pt-0.5 border-t border-border/60">Rest CHF</span>
                  <span className={`tabular-nums text-right font-semibold pt-0.5 border-t border-border/60 ${forecastChf - actualChf <= 0 ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-300"}`}>
                    CHF {CHFFmt.format(Math.max(0, forecastChf - actualChf))}
                  </span>
                </>)}
              </div>
            )}
          </div>
        )}
        {project.decision_note && (
          <div className="mt-2 p-2 rounded-lg bg-muted/40 text-[11px]">
            <p className="text-muted-foreground/70 mb-0.5">Genehmigungs-Kommentar:</p>
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

function HistoryCard({ project, children_, audit }: { project: Project; children_: Child[]; audit: AuditEntry[] }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Historie</p>
        </div>

        {/* Genehmigungs- / Abschluss-Kommentare */}
        {project.decision_note && (
          <div className="p-2 rounded-lg bg-muted/20 text-[11px]">
            <p className="text-muted-foreground/70 mb-0.5">Genehmigungs-Kommentar:</p>
            <p>{project.decision_note}</p>
            {project.approver?.full_name && project.approved_at && (
              <p className="text-muted-foreground/60 mt-1">
                {project.approver.full_name} · {new Date(project.approved_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}
              </p>
            )}
          </div>
        )}
        {project.completion_note && (
          <div className="p-2 rounded-lg bg-muted/20 text-[11px]">
            <p className="text-muted-foreground/70 mb-0.5">Abschluss-Notiz:</p>
            <p>{project.completion_note}</p>
          </div>
        )}

        {/* Vorgänger + Folgeprojekte */}
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

        {/* Audit-Timeline (Budget-Änderungen etc.) */}
        {audit.length > 0 && (
          <div className="space-y-1 pt-2 border-t border-border/60">
            <p className="text-[10px] text-muted-foreground">Änderungen:</p>
            {audit.map((a) => (
              <div key={a.id} className="p-2 rounded-lg bg-muted/20 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">
                    {a.kind === "budget" ? "Budget geändert" : a.kind === "status" ? "Status geändert" : "Zuweisung geändert"}
                  </span>
                  {a.old_value != null && (
                    <span className="text-muted-foreground tabular-nums">{a.old_value} → <strong>{a.new_value}</strong></span>
                  )}
                </div>
                {a.reason && <p className="text-muted-foreground mt-0.5">{a.reason}</p>}
                <p className="text-muted-foreground/60 text-[10px] mt-0.5">
                  {a.changer?.full_name ?? "—"} · {new Date(a.created_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
   TEAM + BUDGET PANEL (analog conceptline)
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
        .neq("role", "partner").eq("is_active", true).order("full_name");
      const memberIds = new Set(members.map((m) => m.user_id));
      setAvailable((data ?? []).filter((p) => !memberIds.has(p.id as string)) as { id: string; full_name: string | null }[]);
    })();
  }, [addOpen, supabase, members]);

  // Wer arbeitet gerade? (offene Stempel — clock_in ohne clock_out)
  const nowStamping = useMemo(() => {
    const map = new Map<string, string>(); // user_id -> clock_in ISO
    for (const e of entries) if (e.clock_in && !e.clock_out) map.set(e.user_id, e.clock_in);
    return map;
  }, [entries]);

  // Letzte Aktion (Ein-/Ausstempel-Event) fuer die "Zuletzt: X …"-Zeile
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

  // Login / Logout / Stempeln
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
    const { data: existing } = await supabase.from("project_time_entries").select("id").eq("user_id", me).is("clock_out", null).maybeSingle();
    if (existing) { setBusy(false); toast.error("Du bist bereits auf einem anderen Projekt eingestempelt."); return; }
    const { error } = await supabase.from("project_time_entries").insert({
      project_id: project.id, user_id: me, clock_in: new Date().toISOString(), description: note.trim() || null,
    });
    setBusy(false);
    if (error) { toast.error("Einstempeln fehlgeschlagen: " + error.message); return; }
    toast.success("Eingestempelt"); setNote(""); onDone();
  }
  async function stampOut() {
    if (!openEntry) return;
    setBusy(true);
    const { error } = await supabase.from("project_time_entries").update({
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
                // Admins zaehlen NICHT in die Prognose — sie werden nicht pro
                // Projekt-Stunde entgeltet. Filter beim avg UND bei den Ist-Kosten.
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
   MEMBERS / LOGIN (legacy — nicht mehr genutzt, wird spaeter entfernt)
   ============================================================ */

function MembersPanel({ members, me, canJoin, isMember, isAdmin, projectId, onDone }: {
  members: Member[];
  me: string | null;
  canJoin: boolean;
  isMember: boolean;
  isAdmin: boolean;
  projectId: string;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [available, setAvailable] = useState<{ id: string; full_name: string | null }[]>([]);
  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => {
    if (!addOpen) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name")
        .neq("role", "partner")
        .eq("is_active", true)
        .order("full_name");
      const memberIds = new Set(members.map((m) => m.user_id));
      setAvailable((data ?? []).filter((p) => !memberIds.has(p.id as string)) as { id: string; full_name: string | null }[]);
    })();
  }, [addOpen, supabase, members]);

  async function addMember(uid: string) {
    setBusy(true);
    const { error } = await supabase.from("project_members").insert({ project_id: projectId, user_id: uid });
    setBusy(false);
    if (error) { toast.error("Hinzufügen fehlgeschlagen: " + error.message); return; }
    toast.success("Mitglied hinzugefügt");
    setAddOpen(false);
    onDone();
  }

  async function login() {
    setBusy(true);
    const { error } = await supabase.from("project_members").insert({ project_id: projectId, user_id: me });
    setBusy(false);
    if (error) { toast.error("Login fehlgeschlagen: " + error.message); return; }
    toast.success("Auf Projekt eingeloggt — du kannst jetzt Zeit stempeln");
    onDone();
  }

  async function logout() {
    const ok = await confirm({
      title: "Vom Projekt ausloggen?",
      message: "Zeit-Einträge bleiben erhalten. Zum Stempeln müsstest du dich neu einloggen.",
      confirmLabel: "Ausloggen",
      variant: "red",
    });
    if (!ok) return;
    setBusy(true);
    const { error } = await supabase.from("project_members").delete()
      .eq("project_id", projectId).eq("user_id", me!);
    setBusy(false);
    if (error) { toast.error("Logout fehlgeschlagen: " + error.message); return; }
    toast.success("Ausgeloggt");
    onDone();
  }

  return (
    <div className="rounded-xl border bg-card p-3 flex items-center gap-3 flex-wrap">
      <Users className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Aktiv am Projekt ({members.length})
        </p>
        {members.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Noch niemand eingeloggt.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {members.map((m) => (
              <span
                key={m.user_id}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${m.user_id === me ? "bg-green-100 text-green-800 dark:bg-green-500/25 dark:text-green-200" : "bg-muted"}`}
                data-tooltip={`seit ${new Date(m.joined_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                {m.full_name ?? "—"}
              </span>
            ))}
          </div>
        )}
      </div>
      {canJoin && (
        <button onClick={login} disabled={busy} className="kasten kasten-green shrink-0">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
          Einloggen & Stempeln
        </button>
      )}
      {isMember && (
        <button onClick={logout} disabled={busy} className="kasten kasten-muted shrink-0" data-tooltip="Vom Projekt ausloggen">
          <LogOut className="h-3.5 w-3.5" />
        </button>
      )}
      {isAdmin && (
        <button onClick={() => setAddOpen(true)} className="kasten kasten-muted shrink-0" data-tooltip="Weitere Mitarbeiter zuteilen">
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
      {ConfirmModalElement}
      {addOpen && (
        <Modal open onClose={() => setAddOpen(false)} title="Mitarbeiter hinzufügen" size="md">
          <p className="text-xs text-muted-foreground mb-3">
            Der ausgewählte Mitarbeiter ist sofort eingeloggt und kann direkt Zeit auf das Projekt stempeln.
          </p>
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
                  <span className="h-6 w-6 rounded-full bg-foreground/10 flex items-center justify-center text-[10px] font-bold">
                    {(a.full_name?.[0] ?? "?").toUpperCase()}
                  </span>
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
    // Beim reinen Budget-Anpassen (nicht Erstgenehmigung): Grund PFLICHT.
    if (mode === "edit-budget" && !note.trim()) {
      toast.error("Bitte Begründung für die Budget-Änderung angeben");
      setSaving(false); return;
    }
    const oldBudget = project.budget_hours;
    const payload: Record<string, unknown> = { budget_hours: b };
    if (mode === "approve") { payload.status = "genehmigt"; payload.approved_by = user?.id ?? null; payload.approved_at = new Date().toISOString(); }
    if (note.trim()) payload.decision_note = note.trim();
    const { error } = await supabase.from("projects").update(payload).eq("id", project.id);
    if (error) { setSaving(false); toast.error("Speichern fehlgeschlagen: " + error.message); return; }

    // Audit-Eintrag: bei approve UND edit-budget einen budget-Log schreiben,
    // damit die Historie nachvollziehbar ist.
    await supabase.from("project_audit").insert({
      project_id: project.id,
      kind: "budget",
      old_value: oldBudget != null ? String(oldBudget) : null,
      new_value: String(b),
      reason: note.trim() || null,
      changed_by: user?.id ?? null,
    });

    setSaving(false);
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
          <p className="text-[10px] text-muted-foreground/70 ml-1">
            {mode === "reject" ? "Kommentar (empfohlen)" : mode === "edit-budget" ? "Begründung *" : "Kommentar"}
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
            placeholder={mode === "reject" ? "Warum wird abgelehnt?" : mode === "edit-budget" ? "Warum wird das Budget geändert?" : "Optional"}
          />
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

  // Teilnehmer-Pool (Mitarbeiter + Kunden) + Auswahl (encoded ids "profile:<uuid>" | "customer:<uuid>")
  const [pickerItems, setPickerItems] = useState<MultiPickerItem[]>([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>(
    (initial?.participants ?? []).map((p) => (p.profile_id ? `profile:${p.profile_id}` : `customer:${p.customer_id}`)),
  );

  useEffect(() => {
    (async () => {
      const [profRes, custRes] = await Promise.all([
        supabase.from("profiles").select("id, full_name").neq("role", "partner").eq("is_active", true).order("full_name"),
        supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
      ]);
      const items: MultiPickerItem[] = [];
      for (const p of (profRes.data ?? []) as { id: string; full_name: string | null }[]) {
        items.push({ id: `profile:${p.id}`, label: p.full_name ?? "—", group: "Mitarbeiter" });
      }
      for (const c of (custRes.data ?? []) as { id: string; name: string | null }[]) {
        items.push({ id: `customer:${c.id}`, label: c.name ?? "—", group: "Kunden" });
      }
      setPickerItems(items);
    })();
  }, [supabase]);

  async function submit() {
    if (!title.trim()) return toast.error("Titel ist Pflicht");
    if (!start) return toast.error("Startzeit ist Pflicht");
    const startIso = new Date(start).toISOString();
    const endIso = end ? new Date(end).toISOString() : null;
    if (endIso && endIso <= startIso) return toast.error("Ende muss nach Start liegen");

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    let apptId = initial?.id ?? null;
    if (initial) {
      const { error } = await supabase.from("project_appointments").update({
        title: title.trim(), description: description.trim() || null, start_time: startIso, end_time: endIso,
      }).eq("id", initial.id);
      if (error) { setSaving(false); toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    } else {
      const { data: inserted, error } = await supabase.from("project_appointments").insert({
        project_id: projectId, title: title.trim(), description: description.trim() || null,
        start_time: startIso, end_time: endIso, created_by: user?.id, assigned_to: user?.id ?? null,
      }).select("id").single();
      if (error || !inserted) { setSaving(false); toast.error("Erstellen fehlgeschlagen: " + (error?.message ?? "unbekannt")); return; }
      apptId = inserted.id as string;
    }

    // Teilnehmer neu schreiben (delete-all + insert-all — einfacher als diff).
    if (apptId) {
      await supabase.from("project_appointment_participants").delete().eq("appointment_id", apptId);
      const rows = selectedParticipantIds.map((sel) => {
        const [kind, uuid] = sel.split(":");
        if (kind === "profile") return { appointment_id: apptId, profile_id: uuid, customer_id: null };
        return { appointment_id: apptId, profile_id: null, customer_id: uuid };
      });
      if (rows.length > 0) {
        const { error: partErr } = await supabase.from("project_appointment_participants").insert(rows);
        if (partErr) { setSaving(false); toast.error("Teilnehmer speichern fehlgeschlagen: " + partErr.message); return; }
      }
    }

    setSaving(false);
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
          <AutoTextarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Teilnehmer</p>
          <MultiPicker
            items={pickerItems}
            selectedIds={selectedParticipantIds}
            onChange={setSelectedParticipantIds}
            placeholder="Mitarbeiter oder Kunde suchen …"
          />
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

/** AppointmentNotesModal — nachträgliche Gesprächs-/Protokoll-Notizen zum Termin.
 *  Notizen sind pro Autor bearbeitbar, Admins können alles löschen. */
interface AppointmentNote {
  id: string;
  content: string;
  created_by: string | null;
  created_at: string;
  author?: { full_name: string | null } | null;
}

function AppointmentNotesModal({
  appointmentId, appointmentTitle, me, isAdmin, onClose, onChanged,
}: {
  appointmentId: string;
  appointmentTitle: string;
  me: string | null;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [notes, setNotes] = useState<AppointmentNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("project_appointment_notes")
      .select("id, content, created_by, created_at, author:created_by(full_name)")
      .eq("appointment_id", appointmentId)
      .order("created_at", { ascending: false });
    setNotes((data ?? []).map((n) => ({
      ...n,
      author: Array.isArray(n.author) ? n.author[0] : n.author,
    })) as AppointmentNote[]);
    setLoading(false);
  }, [supabase, appointmentId]);

  useEffect(() => { load(); }, [load]);

  async function addNote() {
    const content = draft.trim();
    if (!content) return toast.error("Notiz darf nicht leer sein");
    if (!me) return toast.error("Nicht angemeldet");
    setSaving(true);
    const { error } = await supabase.from("project_appointment_notes").insert({
      appointment_id: appointmentId, content, created_by: me,
    });
    setSaving(false);
    if (error) { toast.error("Notiz speichern fehlgeschlagen: " + error.message); return; }
    toast.success("Notiz hinzugefügt");
    setDraft("");
    await load();
    onChanged();
  }

  async function delNote(n: AppointmentNote) {
    const ok = await confirm({
      title: "Notiz löschen?",
      message: "Die Notiz wird endgültig entfernt.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("project_appointment_notes").delete().eq("id", n.id);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    toast.success("Gelöscht");
    await load();
    onChanged();
  }

  return (
    <Modal open onClose={onClose} title={`Notizen: ${appointmentTitle}`} size="md">
      <div className="space-y-3">
        {loading ? (
          <p className="text-xs text-muted-foreground italic">Lädt …</p>
        ) : notes.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Noch keine Notizen.</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {notes.map((n) => {
              const canDelete = isAdmin || (me != null && n.created_by === me);
              return (
                <div key={n.id} className="p-2 rounded-lg bg-muted/20 text-sm">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{n.author?.full_name ?? "—"}</span>
                        {" · "}
                        {new Date(n.created_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </p>
                      <p className="whitespace-pre-wrap mt-0.5">{n.content}</p>
                    </div>
                    {canDelete && (
                      <button onClick={() => delNote(n)} className="text-muted-foreground hover:text-destructive shrink-0" aria-label="Löschen">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="space-y-1 pt-2 border-t border-border/60">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Neue Notiz</p>
          <AutoTextarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Was wurde besprochen?"
            className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Schliessen</button>
            <button onClick={addNote} disabled={saving || !draft.trim()} className="kasten kasten-red flex-1">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {saving ? "…" : "Notiz hinzufügen"}
            </button>
          </div>
        </div>
        {ConfirmModalElement}
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
  const { confirm, ConfirmModalElement } = useConfirm();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string; mime: string | null } | null>(null);

  async function previewDocInBrowser(doc: DocRow) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
    if (error || !data?.signedUrl) { toast.error("Datei nicht verfügbar"); return; }
    setPreviewDoc({ url: data.signedUrl, title: doc.name, mime: doc.mime_type });
  }
  async function downloadDoc(doc: DocRow) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
    if (error || !data?.signedUrl) { toast.error("Datei nicht verfügbar"); return; }
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = doc.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

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

  async function deleteDoc(doc: DocRow) {
    const ok = await confirm({
      title: "Dokument löschen?",
      message: `"${doc.name}" wird unwiderruflich entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
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
                <button onClick={() => previewDocInBrowser(d)} className="flex-1 min-w-0 text-left hover:underline">
                  <span className="block truncate">{d.name}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {d.file_size ? `${(d.file_size / 1024).toFixed(0)} KB · ` : ""}
                    {d.uploader?.full_name ?? "—"} · {new Date(d.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                  </span>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => previewDocInBrowser(d)} className="kasten kasten-blue !py-1 !px-2" data-tooltip="Vorschau">
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => downloadDoc(d)} className="kasten kasten-muted !py-1 !px-2" data-tooltip="Herunterladen">
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  {(isAdmin || me === d.uploaded_by) && (
                    <button onClick={() => deleteDoc(d)} className="kasten kasten-red !py-1 !px-2" data-tooltip="Löschen">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {ConfirmModalElement}
        {previewDoc && (
          <Modal open onClose={() => setPreviewDoc(null)} title={previewDoc.title} size="lg">
            <div className="w-full" style={{ height: "70vh" }}>
              {previewDoc.mime?.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewDoc.url} alt={previewDoc.title} className="w-full h-full object-contain" />
              ) : (
                <iframe src={previewDoc.url} title={previewDoc.title} className="w-full h-full rounded" />
              )}
            </div>
            <div className="flex justify-end pt-2">
              <a href={previewDoc.url} download={previewDoc.title} className="kasten kasten-muted">
                <Download className="h-3.5 w-3.5" /> Herunterladen
              </a>
            </div>
          </Modal>
        )}
      </CardContent>
    </Card>
  );
}
