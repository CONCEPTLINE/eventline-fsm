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
 *   - Beschreibung + Fortschritts-Balken (verbraucht/Budget)
 *   - Zeit-Eintraege (Liste, chronologisch neuest zuerst)
 *   - Stempel-Form (nur wenn genehmigt + user = assignee)
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
import { Clock, CheckCircle2, XCircle, Save, Loader2, Trash2, Edit3 } from "lucide-react";
import { toast } from "sonner";
import { formatHours, progressPct, progressColorClass, PROJECT_STATUS_LABEL } from "@/lib/projekte-format";
import { todayLocalIso } from "@/lib/swiss-time";

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
  assignee?: { full_name: string | null } | null;
  approver?: { full_name: string | null } | null;
}

interface TimeEntry {
  id: string;
  entry_date: string;
  minutes: number;
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
      .select("*, user:profiles!project_time_entries_user_id_fkey(full_name)")
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
  const usedMin = entries.reduce((a, e) => a + e.minutes, 0);
  const pct = progressPct(usedMin, project.budget_hours);
  const remainingH = project.budget_hours != null ? Math.max(0, project.budget_hours - usedMin / 60) : null;
  const canStamp = me === project.assigned_to && project.status === "genehmigt";
  const canApprove = isAdmin && project.status === "angefragt";
  const canClose = isAdmin && project.status === "genehmigt";

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

      {/* Admin-Actions */}
      {(canApprove || canClose) && (
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
        </div>
      )}

      {/* Stempeln (nur wenn genehmigt + eigenes Projekt + Budget nicht aufgebraucht) */}
      {canStamp && pct < 100 && (
        <StampForm projectId={project.id} onDone={load} maxMinutes={remainingH != null ? Math.floor(remainingH * 60) : undefined} />
      )}

      {/* Zeit-Einträge */}
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zeit-Einträge ({entries.length})</p>
        {entries.length === 0 ? (
          <Card><CardContent className="p-4 text-xs text-muted-foreground text-center">Noch keine Zeit gebucht.</CardContent></Card>
        ) : (
          <div className="space-y-1">
            {entries.map((e) => (
              <Card key={e.id}>
                <CardContent className="p-3 flex items-center gap-3">
                  <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium tabular-nums">{formatHours(e.minutes)}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(e.entry_date + "T12:00:00").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                      </span>
                      {isAdmin && e.user?.full_name && (
                        <span className="text-[11px] text-muted-foreground">· {e.user.full_name}</span>
                      )}
                    </div>
                    {e.description && <p className="text-[12px] text-muted-foreground truncate">{e.description}</p>}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {decisionOpen && (
        <DecisionModal
          mode={decisionOpen}
          project={project}
          onClose={() => setDecisionOpen(null)}
          onDone={() => { setDecisionOpen(null); load(); }}
        />
      )}
      {ConfirmModalElement}
    </div>
  );
}

/** Stempel-Form: Datum, Minuten, Beschreibung. */
function StampForm({ projectId, onDone, maxMinutes }: { projectId: string; onDone: () => void; maxMinutes?: number }) {
  const supabase = createClient();
  const [date, setDate] = useState(todayLocalIso());
  const [hours, setHours] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const h = parseFloat(hours.replace(",", "."));
    if (!Number.isFinite(h) || h <= 0) return toast.error("Bitte eine positive Stundenzahl angeben");
    const minutes = Math.round(h * 60);
    if (minutes > 1440) return toast.error("Max 24 h pro Eintrag");
    if (maxMinutes != null && minutes > maxMinutes) {
      return toast.error(`Nur noch ${(maxMinutes / 60).toLocaleString("de-CH", { maximumFractionDigits: 2 })} h Budget übrig.`);
    }
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }
    const { error } = await supabase.from("project_time_entries").insert({
      project_id: projectId,
      user_id: user.id,
      entry_date: date,
      minutes,
      description: desc.trim() || null,
    });
    setSaving(false);
    if (error) { toast.error("Buchen fehlgeschlagen: " + error.message); return; }
    toast.success(`${h.toLocaleString("de-CH", { maximumFractionDigits: 2 })} h gebucht`);
    setHours("");
    setDesc("");
    onDone();
  }

  return (
    <form onSubmit={submit} className="rounded-xl border bg-card p-4 space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <Clock className="h-3 w-3" /> Zeit buchen
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground/70 ml-1">Datum</p>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground/70 ml-1">Stunden</p>
          <Input type="text" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="z.B. 1.5" required />
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-[10px] text-muted-foreground/70 ml-1">Notiz (optional)</p>
        <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Woran hast du gearbeitet?" />
      </div>
      <button type="submit" disabled={saving} className="kasten kasten-red w-full">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        {saving ? "Bucht…" : "Zeit buchen"}
      </button>
    </form>
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
