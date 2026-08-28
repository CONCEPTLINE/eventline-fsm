"use client";

/**
 * /projekte/[id] — Detail eines Projekts.
 *
 * Sichtbar fuer:
 *   - Assignee/Creator (RLS): sieht Details, kann Zeit stempeln solange
 *     Status = 'genehmigt'.
 *   - Admin: sieht alle, kann bei 'angefragt' genehmigen/ablehnen,
 *     kann Budget nachtraeglich anpassen, kann Projekt schliessen.
 *
 * Layout:
 *   - Header: Titel, Status-Chip, Assignee
 *   - Zeitraum (von/bis) + abgeleitete Phase + Zeit-Fortschritt
 *   - Beschreibung + Fortschritts-Balken (verbraucht/Budget)
 *   - Zeit-Eintraege (Liste, chronologisch neuest zuerst)
 *   - Stempel-Form (nur wenn genehmigt + user = assignee)
 *   - Termine (landen im Kalender) + Notizbloecke + Dokumente
 *   - Admin-Actions: Genehmigen/Ablehnen/Abschliessen/Budget aendern
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
import { Loading } from "@/components/ui/spinner";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { Clock, CheckCircle2, XCircle, Save, Loader2, Trash2, Edit3, Paperclip, FileText, X, Ban, CalendarRange, CopyPlus } from "lucide-react";
import { validateFileList } from "@/lib/file-upload";
import { toast } from "sonner";
import {
  formatHours, progressPct, progressColorClass, PROJECT_STATUS_LABEL,
  formatProjectRange, projectDurationDays, projectPhase, timeProgressPct,
} from "@/lib/projekte-format";
import { todayLocalDateString } from "@/lib/format";
import { ProjektTermine } from "@/components/projekte/projekt-termine";
import { ProjektNotizen } from "@/components/projekte/projekt-notizen";

interface Project {
  id: string;
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
  created_at: string;
  /** DATE-Spalten — Supabase liefert "YYYY-MM-DD". */
  start_date: string | null;
  end_date: string | null;
  assignee?: { full_name: string | null } | null;
  approver?: { full_name: string | null } | null;
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
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decisionOpen, setDecisionOpen] = useState<"approve" | "reject" | "edit-budget" | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [zeitraumOpen, setZeitraumOpen] = useState(false);
  const [folgeOpen, setFolgeOpen] = useState(false);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setMe(user?.id ?? null);
    const { data: p } = await supabase
      .from("projects")
      .select("*, assignee:profiles!projects_assigned_to_fkey(full_name), approver:profiles!projects_approved_by_fkey(full_name)")
      .eq("id", projectId)
      .maybeSingle();
    if (p) {
      setProject({
        ...p,
        assignee: Array.isArray(p.assignee) ? p.assignee[0] : p.assignee,
        approver: Array.isArray(p.approver) ? p.approver[0] : p.approver,
      } as Project);
    }
    const { data: es } = await supabase
      .from("project_time_entries")
      .select("id, entry_date, minutes, clock_in, clock_out, description, user_id, created_at, user:profiles!project_time_entries_user_id_fkey(full_name)")
      .eq("project_id", projectId)
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false });
    setEntries((es ?? []).map((e) => ({
      ...e,
      user: Array.isArray(e.user) ? e.user[0] : e.user,
    })) as TimeEntry[]);
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading />;
  if (!project) return <div className="text-sm text-muted-foreground">Projekt nicht gefunden.</div>;

  const status = PROJECT_STATUS_LABEL[project.status];
  // Nur geschlossene Stempel zaehlen fuer den Fortschritt — der laufende
  // Stempel wird per Live-Timer separat visualisiert.
  const usedMin = entries.reduce((a, e) => a + (e.minutes ?? 0), 0);
  const openEntry = entries.find((e) => e.clock_in && !e.clock_out && e.user_id === me);
  const pct = progressPct(usedMin, project.budget_hours);
  const remainingH = project.budget_hours != null ? Math.max(0, project.budget_hours - usedMin / 60) : null;
  const canStamp = me === project.assigned_to && project.status === "genehmigt";
  const canApprove = isAdmin && project.status === "angefragt";
  const canClose = isAdmin && project.status === "genehmigt";
  const isArchived = project.status === "storniert" || project.status === "abgeschlossen" || project.status === "abgelehnt";
  const canCancel = !isArchived && (isAdmin || me === project.assigned_to || me === project.created_by);

  // Zeitraum — abgeleitete Anzeige, kein zweiter Status.
  const today = todayLocalDateString();
  const phase = projectPhase(project.start_date, project.end_date, project.status, today);
  const rangeLabel = formatProjectRange(project.start_date, project.end_date);
  const durationDays = projectDurationDays(project.start_date, project.end_date);
  const timePct = timeProgressPct(project.start_date, project.end_date, today);
  // Spiegelt die RLS-Policy projects_update: Non-Admins duerfen ihr
  // Projekt nur solange es 'angefragt' ist aendern. Ohne diese Klemme
  // waere der Button sichtbar und der Save wuerde still scheitern.
  const canEditZeitraum = isAdmin || (me === project.assigned_to && project.status === "angefragt");
  const canDuplicate = isAdmin || me === project.assigned_to || me === project.created_by;
  // Termine und Notizen haengen an can_access_project() — Assignee und
  // Ersteller duerfen unabhaengig vom Status. Im Archiv nur noch lesen.
  const subReadOnly = isArchived;

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
    <div className="max-w-3xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <BackButton fallbackHref="/projekte" size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold truncate">{project.title}</h1>
            <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${status.color}`}>
              {status.label}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {project.assignee?.full_name ?? "—"} · angelegt {new Date(project.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
          </p>
        </div>
        {isAdmin && (
          <button onClick={deleteProject} className="kasten kasten-muted" data-tooltip="Projekt löschen">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Beschreibung + Budget */}
      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Zeitraum — Datum, abgeleitete Phase, Zeit-Fortschritt. Bewusst
              getrennt vom Budget-Balken darunter: der eine zeigt Stunden,
              der andere Kalendertage. */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <CalendarRange className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {rangeLabel ? (
                <>
                  <span className="text-sm font-medium">{rangeLabel}</span>
                  {durationDays != null && (
                    <span className="text-[11px] text-muted-foreground">
                      · {durationDays} {durationDays === 1 ? "Tag" : "Tage"}
                    </span>
                  )}
                  {phase && (
                    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-semibold rounded-full ${phase.color}`}>
                      {phase.label}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-sm text-muted-foreground">Kein Zeitraum gesetzt</span>
              )}
              {canEditZeitraum && (
                <button
                  onClick={() => setZeitraumOpen(true)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  data-tooltip="Zeitraum bearbeiten"
                  aria-label="Zeitraum bearbeiten"
                >
                  <Edit3 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {timePct != null && (
              <div className="h-1 rounded-full bg-foreground/[0.08] overflow-hidden">
                <div
                  className={`h-full transition-all ${phase?.key === "ueberfaellig" ? "bg-red-500" : "bg-blue-500"}`}
                  style={{ width: `${timePct}%` }}
                />
              </div>
            )}
          </div>

          {project.description && (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{project.description}</p>
          )}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground/70">Vorschlag MA</p>
              <p className="font-medium">
                {project.proposed_hours != null ? `${project.proposed_hours.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h` : "—"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground/70">Genehmigtes Budget</p>
              <p className="font-medium">
                {project.budget_hours != null ? `${project.budget_hours.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h` : "— (noch nicht genehmigt)"}
              </p>
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
              {pct >= 100 && (
                <p className="text-[11px] text-red-600 dark:text-red-400 font-medium">Budget aufgebraucht — keine neue Zeit mehr buchbar.</p>
              )}
              {pct >= 80 && pct < 100 && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">Achtung: {Math.round(pct)}% des Budgets verbraucht.</p>
              )}
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
        </CardContent>
      </Card>

      {/* Actions */}
      {(canApprove || canClose || canCancel || canDuplicate) && (
        <div className="flex gap-2 flex-wrap">
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
                <Edit3 className="h-3.5 w-3.5" /> Budget anpassen
              </button>
              <button
                onClick={async () => {
                  const ok = await confirm({
                    title: "Projekt abschließen?",
                    message: "Nach dem Abschluss kann keine Zeit mehr gebucht werden. Bestehende Einträge bleiben erhalten.",
                    confirmLabel: "Abschließen",
                    variant: "blue",
                  });
                  if (!ok) return;
                  await supabase.from("projects").update({ status: "abgeschlossen" }).eq("id", projectId);
                  toast.success("Projekt abgeschlossen");
                  load();
                }}
                className="kasten kasten-muted"
              >
                Abschließen
              </button>
            </>
          )}
          {canCancel && (
            <button onClick={() => setCancelOpen(true)} className="kasten kasten-red">
              <Ban className="h-3.5 w-3.5" /> Stornieren
            </button>
          )}
          {/* Auch (und gerade) im Archiv verfuegbar: ein abgeschlossenes
              Projekt ist die beste Vorlage fuer den naechsten Durchlauf. */}
          {canDuplicate && (
            <button onClick={() => setFolgeOpen(true)} className="kasten kasten-muted">
              <CopyPlus className="h-3.5 w-3.5" /> Folgeprojekt
            </button>
          )}
        </div>
      )}

      {/* Stempeln (nur wenn genehmigt + eigenes Projekt) */}
      {canStamp && (
        <StampControl
          projectId={project.id}
          openEntry={openEntry ?? null}
          budgetAufgebraucht={pct >= 100}
          onDone={load}
        />
      )}

      {/* Zeit-Einträge */}
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zeit-Einträge ({entries.length})</p>
        {entries.length === 0 ? (
          <Card><CardContent className="p-4 text-xs text-muted-foreground text-center">Noch keine Zeit gebucht.</CardContent></Card>
        ) : (
          <div className="space-y-1">
            {entries.map((e) => {
              const isOpen = !!e.clock_in && !e.clock_out;
              return (
                <Card key={e.id} className={isOpen ? "border-green-500/50" : ""}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <Clock className={`h-4 w-4 shrink-0 ${isOpen ? "text-green-500 animate-pulse" : "text-muted-foreground"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isOpen ? (
                          <span className="text-sm font-medium text-green-600 dark:text-green-400">Läuft …</span>
                        ) : (
                          <span className="text-sm font-medium tabular-nums">{formatHours(e.minutes)}</span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(e.entry_date + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                          {e.clock_in && ` · ${new Date(e.clock_in).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}`}
                          {e.clock_out && ` – ${new Date(e.clock_out).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}`}
                        </span>
                        {isAdmin && e.user?.full_name && (
                          <span className="text-[11px] text-muted-foreground">· {e.user.full_name}</span>
                        )}
                      </div>
                      {e.description && <p className="text-[12px] text-muted-foreground truncate">{e.description}</p>}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Termine — landen ueber job_appointments.project_id im Kalender */}
      <ProjektTermine
        projectId={project.id}
        startDate={project.start_date}
        endDate={project.end_date}
        readOnly={subReadOnly}
      />

      {/* Notizbloecke */}
      <ProjektNotizen projectId={project.id} readOnly={subReadOnly} />

      {/* Dokumente */}
      <ProjectDocuments projectId={project.id} isAdmin={isAdmin} canUpload={me === project.assigned_to || isAdmin} />

      {decisionOpen && (
        <DecisionModal
          mode={decisionOpen}
          project={project}
          onClose={() => setDecisionOpen(null)}
          onDone={() => { setDecisionOpen(null); load(); }}
        />
      )}
      {cancelOpen && (
        <CancelModal
          projectId={project.id}
          onClose={() => setCancelOpen(false)}
          onDone={() => { setCancelOpen(false); load(); }}
        />
      )}
      {zeitraumOpen && (
        <ZeitraumModal
          project={project}
          onClose={() => setZeitraumOpen(false)}
          onDone={() => { setZeitraumOpen(false); load(); }}
        />
      )}
      {folgeOpen && (
        <FolgeprojektModal
          project={project}
          onClose={() => setFolgeOpen(false)}
        />
      )}
      {ConfirmModalElement}
    </div>
  );
}

/** Stornieren-Modal mit Pflicht-Begruendung. Ruft die RPC cancel_project. */
function CancelModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const supabase = createClient();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!reason.trim()) return toast.error("Begründung ist Pflicht");
    setSaving(true);
    const { error } = await supabase.rpc("cancel_project", {
      p_project_id: projectId,
      p_reason: reason.trim(),
    });
    setSaving(false);
    if (error) { toast.error("Stornieren fehlgeschlagen: " + error.message); return; }
    toast.success("Projekt storniert");
    onDone();
  }

  return (
    <Modal open onClose={onClose} title="Projekt stornieren" size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Das Projekt wird als storniert ins Archiv verschoben. Zeit-Einträge bleiben erhalten.
        </p>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Begründung *</p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            autoFocus
            className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
            placeholder="Warum wird das Projekt storniert?"
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button onClick={submit} disabled={saving || !reason.trim()} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
            {saving ? "Storniert…" : "Stornieren"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Zeitraum bearbeiten. Beide Felder duerfen leer bleiben — ein Projekt
 *  ohne Planung ist gueltig. Die Reihenfolge-Pruefung spiegelt den
 *  DB-Constraint projects_dates_check. */
function ZeitraumModal({ project, onClose, onDone }: {
  project: Project;
  onClose: () => void;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [start, setStart] = useState(project.start_date ?? "");
  const [end, setEnd] = useState(project.end_date ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (start && end && end < start) return toast.error("Das Ende liegt vor dem Start");
    setSaving(true);
    const { error } = await supabase
      .from("projects")
      .update({ start_date: start || null, end_date: end || null })
      .eq("id", project.id);
    setSaving(false);
    if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    toast.success("Zeitraum gespeichert");
    onDone();
  }

  return (
    <Modal open onClose={onClose} title="Zeitraum bearbeiten" size="md">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Von</p>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bis</p>
            <Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Beide Felder sind optional. Ohne Enddatum läuft das Projekt offen weiter.
        </p>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button onClick={submit} disabled={saving} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Speichert…" : "Speichern"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Folgeprojekt: legt eine Kopie mit neuem Zeitraum an. Uebernommen
 *  werden Titel, Beschreibung, Zuweisung und die Notizblock-Struktur —
 *  nicht die Inhalte, Zeit-Eintraege oder das Budget (siehe RPC
 *  duplicate_project, Migration 190). */
function FolgeprojektModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const supabase = createClient();
  const router = useRouter();
  const [title, setTitle] = useState(`${project.title} (Kopie)`);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim()) return toast.error("Titel ist Pflicht");
    if (start && end && end < start) return toast.error("Das Ende liegt vor dem Start");
    setSaving(true);
    const { data, error } = await supabase.rpc("duplicate_project", {
      p_project_id: project.id,
      p_title: title.trim(),
      p_start_date: start || null,
      p_end_date: end || null,
    });
    setSaving(false);
    if (error || !data) {
      toast.error("Folgeprojekt fehlgeschlagen: " + (error?.message ?? "?"));
      return;
    }
    toast.success("Folgeprojekt angelegt — wartet auf Genehmigung");
    router.push(`/projekte/${data as string}`);
  }

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} title="Folgeprojekt anlegen" size="md" closable={!saving}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Übernommen werden Titel, Beschreibung, Zuweisung und die Struktur der Notizblöcke — ohne Inhalte,
          Zeit-Einträge und Budget. Das neue Projekt startet als Anfrage und muss neu genehmigt werden.
        </p>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Titel *</p>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Von</p>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bis</p>
            <Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button onClick={submit} disabled={saving} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CopyPlus className="h-3.5 w-3.5" />}
            {saving ? "Legt an…" : "Anlegen"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

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

/** Dokumenten-Sektion: Liste, Upload, Download-Link, Loeschen (Owner/Admin). */
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
    setDocs((data ?? []).map((d) => ({
      ...d,
      uploader: Array.isArray(d.uploader) ? d.uploader[0] : d.uploader,
    })) as DocRow[]);
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
        const fd = new FormData();
        fd.append("file", file);
        fd.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const j = await res.json();
        if (!j.success) { fail++; continue; }
        const { error } = await supabase.from("documents").insert({
          name: file.name,
          storage_path: path,
          file_size: file.size,
          mime_type: file.type,
          project_id: projectId,
          uploaded_by: user.id,
        });
        if (error) fail++;
        else ok++;
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
    <div className="space-y-1">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        <Paperclip className="h-3 w-3" /> Dokumente ({docs.length})
      </p>
      {canUpload && (
        <label className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed bg-muted/20 text-sm text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors cursor-pointer">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          {uploading ? "Lädt hoch…" : "Dateien auswählen…"}
          <input
            type="file"
            multiple
            className="sr-only"
            disabled={uploading}
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
          />
        </label>
      )}
      {loading ? (
        <p className="text-xs text-muted-foreground p-2">Lädt…</p>
      ) : docs.length === 0 ? (
        !canUpload && <p className="text-xs text-muted-foreground p-2">Keine Dokumente.</p>
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
                <button
                  onClick={() => deleteDoc(d)}
                  className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                  aria-label="Löschen"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** StampControl — Einstempeln / Ausstempeln.
 *  Zeigt "Einstempeln"-Button wenn kein offener Stempel; bei offenem
 *  Stempel Live-Timer + "Ausstempeln"-Button + Notiz-Feld. */
function StampControl({
  projectId,
  openEntry,
  budgetAufgebraucht,
  onDone,
}: {
  projectId: string;
  openEntry: TimeEntry | null;
  budgetAufgebraucht: boolean;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(openEntry?.description ?? "");
  const [tick, setTick] = useState(0);

  // Live-Timer: 1× pro Sekunde re-rendern solange offener Stempel laeuft.
  useEffect(() => {
    if (!openEntry) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [openEntry]);

  async function stampIn() {
    if (budgetAufgebraucht) return toast.error("Budget aufgebraucht — keine neue Zeit buchbar.");
    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setBusy(false); return; }
    // Erst prüfen ob User schon irgendwo eingestempelt ist (auf anderes Projekt)
    const { data: existing } = await supabase
      .from("project_time_entries")
      .select("id, project_id")
      .eq("user_id", user.id)
      .is("clock_out", null)
      .maybeSingle();
    if (existing) {
      setBusy(false);
      toast.error("Du bist bereits auf einem anderen Projekt eingestempelt — dort erst ausstempeln.");
      return;
    }
    const { error } = await supabase.from("project_time_entries").insert({
      project_id: projectId,
      user_id: user.id,
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
    const h = Math.floor(elapsed / 3600000);
    const m = Math.floor((elapsed % 3600000) / 60000);
    const s = Math.floor((elapsed % 60000) / 1000);
    const _ = tick; // dependency ohne Warnung
    void _;
    return (
      <div className="rounded-xl border-2 border-green-500/60 bg-green-500/5 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse" />
          <div className="flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-400">Eingestempelt seit</p>
            <p className="text-2xl font-bold tabular-nums text-green-700 dark:text-green-400">
              {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Start {new Date(openEntry.clock_in!).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground/70 ml-1">Notiz (optional)</p>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Woran arbeitest du?" />
        </div>
        <button onClick={stampOut} disabled={busy} className="kasten kasten-red w-full">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
          {busy ? "…" : "Ausstempeln"}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <Clock className="h-3 w-3" /> Zeit erfassen
      </p>
      <div className="space-y-1">
        <p className="text-[10px] text-muted-foreground/70 ml-1">Notiz (optional, jetzt oder beim Ausstempeln)</p>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Woran arbeitest du?" />
      </div>
      <button
        onClick={stampIn}
        disabled={busy || budgetAufgebraucht}
        className="kasten kasten-green w-full"
        data-tooltip={budgetAufgebraucht ? "Budget aufgebraucht — Admin muss erhöhen" : undefined}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
        {busy ? "…" : budgetAufgebraucht ? "Budget aufgebraucht" : "Einstempeln"}
      </button>
    </div>
  );
}

/** Modal fuer Admin-Entscheidungen: Genehmigen / Ablehnen / Budget-Anpassung. */
function DecisionModal({ mode, project, onClose, onDone }: {
  mode: "approve" | "reject" | "edit-budget";
  project: Project;
  onClose: () => void;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [budget, setBudget] = useState(
    mode === "approve"
      ? (project.proposed_hours?.toString() ?? "")
      : mode === "edit-budget"
        ? (project.budget_hours?.toString() ?? "")
        : ""
  );
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const title = mode === "approve" ? "Projekt genehmigen"
    : mode === "reject" ? "Projekt ablehnen"
    : "Budget anpassen";

  async function submit() {
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();

    if (mode === "reject") {
      const { error } = await supabase.from("projects").update({
        status: "abgelehnt",
        approved_by: user?.id ?? null,
        approved_at: new Date().toISOString(),
        decision_note: note.trim() || null,
      }).eq("id", project.id);
      setSaving(false);
      if (error) { toast.error("Ablehnen fehlgeschlagen: " + error.message); return; }
      toast.success("Projekt abgelehnt");
      onDone();
      return;
    }

    const b = parseFloat(budget.replace(",", "."));
    if (!Number.isFinite(b) || b <= 0) { toast.error("Bitte Budget-Stunden angeben"); setSaving(false); return; }
    if (b > 99999) { toast.error("Zu hoch"); setSaving(false); return; }

    const payload: Record<string, unknown> = { budget_hours: b };
    if (mode === "approve") {
      payload.status = "genehmigt";
      payload.approved_by = user?.id ?? null;
      payload.approved_at = new Date().toISOString();
    }
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
            <p className="text-[10px] text-muted-foreground/70 ml-1">
              Budget in Stunden {project.proposed_hours != null && mode === "approve" && `(Vorschlag: ${project.proposed_hours})`}
            </p>
            <Input type="text" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} autoFocus />
          </div>
        )}
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground/70 ml-1">
            Kommentar {mode === "reject" && "(empfohlen)"}
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
            placeholder={mode === "reject" ? "Warum wird abgelehnt?" : "Optional"}
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button
            onClick={submit}
            disabled={saving}
            className={`flex-1 kasten ${mode === "reject" ? "kasten-red" : mode === "approve" ? "kasten-green" : "kasten-red"}`}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : mode === "approve" ? <CheckCircle2 className="h-3.5 w-3.5" /> : mode === "reject" ? <XCircle className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "…" : mode === "approve" ? "Genehmigen" : mode === "reject" ? "Ablehnen" : "Speichern"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
