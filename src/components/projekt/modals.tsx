"use client";

/**
 * Modals fuer /projekte/[id] -- an einer Stelle, damit page.tsx nicht
 * unter der Modal-Definition-Last aechzt.
 *
 *   - DecisionModal (approve/reject/edit-budget)
 *   - CancelModal
 *   - CloseModal
 *   - AppointmentModal (create/edit)
 *   - AppointmentNotesModal (Gespraechs-Notizen zum Termin)
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/use-confirm";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { MultiPicker, type MultiPickerItem } from "@/components/ui/multi-picker";
import {
  CheckCircle2, XCircle, Save, Loader2, Ban, Plus, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { Appointment, Project } from "./types";

export function DecisionModal({ mode, project, onClose, onDone }: {
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

export function CancelModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
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

export function CloseModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
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
    <Modal open onClose={onClose} title="Projekt abschliessen" size="md">
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
            {saving ? "…" : "Abschliessen"}
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

export function AppointmentModal({ projectId, initial, onClose, onDone }: {
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

  const [pickerItems, setPickerItems] = useState<MultiPickerItem[]>([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>(
    (initial?.participants ?? []).map((p) => (p.profile_id ? `profile:${p.profile_id}` : `customer:${p.customer_id}`)),
  );

  useEffect(() => {
    (async () => {
      const [profRes, custRes] = await Promise.all([
        supabase.from("profiles").select("id, full_name").neq("role", "partner").neq("role", "lieferant").eq("is_active", true).order("full_name"),
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

interface AppointmentNote {
  id: string;
  content: string;
  created_by: string | null;
  created_at: string;
  author?: { full_name: string | null } | null;
}

export function AppointmentNotesModal({
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
