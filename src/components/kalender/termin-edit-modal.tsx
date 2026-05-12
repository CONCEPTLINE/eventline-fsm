"use client";

/**
 * Modal um einen einzelnen Termin (job_appointments-Row) zu bearbeiten
 * oder zu loeschen.
 *
 * Wird aus dem Kalender geoeffnet wenn der User auf einen "Nicht Auftrag
 * bezogen"-Termin (job_id=null) klickt — fuer die gabs vorher keinen
 * UI-Pfad zum Loeschen, weil die AppointmentsSection nur auf der Auftrag-
 * Detail-Page lebt.
 *
 * Single-Row-Edit: ein Termin pro Mitarbeiter ist eine eigene DB-Row
 * (assigned_to = uuid, NOT NULL). Wenn dieselbe "logische" Termin-Idee
 * mehreren Personen zugewiesen ist, sind das mehrere Rows — jede ist
 * separat editierbar/loeschbar. Konsistent mit AppointmentsSection.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/use-confirm";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { logError } from "@/lib/log";
import { Trash2, User } from "lucide-react";
import { toLocalIsoString } from "@/lib/format";

interface Props {
  /** id des Termins (job_appointments.id). null = Modal zu. */
  apptId: string | null;
  onClose: () => void;
  /** Nach erfolgreichem Save oder Delete: Kalender neu laden. */
  onChanged: () => void;
}

interface ApptRow {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  description: string | null;
  job_id: string | null;
  assigned_to: string;
  assignee: { full_name: string } | null;
}

// YYYY-MM-DD im LOKALEN Timezone — gleicher Helper wie in NeuerTerminModal
// (Date.toISOString() konvertiert in UTC was in CET/CEST oft den Tag
// zurueckrolllt).
function toLocalDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function toLocalTime(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function TerminEditModal({ apptId, onClose, onChanged }: Props) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();

  const [loading, setLoading] = useState(false);
  const [appt, setAppt] = useState<ApptRow | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const open = apptId !== null;

  // Beim Oeffnen: Termin laden + Form-State befuellen.
  useEffect(() => {
    if (!apptId) return;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from("job_appointments")
        .select("id, title, start_time, end_time, description, job_id, assigned_to, assignee:profiles!assigned_to(full_name)")
        .eq("id", apptId)
        .maybeSingle();
      if (error || !data) {
        logError("kalender.termin-edit.load", error, { apptId });
        toast.error("Termin konnte nicht geladen werden");
        onClose();
        return;
      }
      const row = data as unknown as ApptRow;
      setAppt(row);
      setTitle(row.title);
      setDate(toLocalDate(row.start_time));
      setStartTime(toLocalTime(row.start_time));
      setEndTime(row.end_time ? toLocalTime(row.end_time) : "");
      setDescription(row.description ?? "");
      setLoading(false);
    })();
  }, [apptId, supabase, onClose]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!appt) return;
    if (!title.trim()) {
      toast.error("Titel fehlt");
      return;
    }
    if (!date || !startTime) {
      toast.error("Datum und Startzeit sind Pflicht");
      return;
    }
    setSaving(true);
    try {
      const startISO = toLocalIsoString(date, startTime);
      const endISO = endTime ? toLocalIsoString(date, endTime) : null;

      const { error } = await supabase
        .from("job_appointments")
        .update({
          title: title.trim(),
          start_time: startISO,
          end_time: endISO,
          description: description.trim() || null,
        })
        .eq("id", appt.id);
      if (error) throw error;

      toast.success("Termin gespeichert");
      onChanged();
      onClose();
    } catch (e) {
      logError("kalender.termin-edit.save", e, { apptId: appt.id });
      TOAST.supabaseError(e, "Termin konnte nicht gespeichert werden");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!appt) return;
    const ok = await confirm({
      title: "Termin löschen?",
      message: "Der Termin wird unwiderruflich gelöscht.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    setDeleting(true);
    const result = await deleteRow("job_appointments", appt.id);
    setDeleting(false);
    if (!result.ok) {
      toast.error(result.error ?? "Termin konnte nicht gelöscht werden");
      return;
    }
    toast.success("Termin gelöscht");
    onChanged();
    onClose();
  }

  return (
    <>
      <Modal
        open={open}
        onClose={() => { if (!saving && !deleting) onClose(); }}
        title="Termin bearbeiten"
        size="md"
        closable={!saving && !deleting}
      >
        {loading || !appt ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Lädt…</div>
        ) : (
          <form onSubmit={save} className="space-y-4">
            {/* Zugewiesen-Info — read-only, weil ein Termin pro Person eine
                eigene Row ist und das hier diese spezifische Row ist. */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 text-sm">
              <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Zugewiesen:</span>
              <span className="font-medium">{appt.assignee?.full_name ?? "—"}</span>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Titel *</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" required />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Datum *</label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" required />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Von *</label>
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="mt-1" required />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Bis</label>
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="mt-1" />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Beschreibung</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 text-sm rounded-lg border bg-card resize-none"
              />
            </div>

            {/* Action-Bar: Loeschen ganz links (destructive, abgesetzt vom
                primaeren Save-CTA rechts), dazwischen Abbrechen. */}
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving || deleting}
                className="kasten kasten-red"
                aria-label="Termin löschen"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? "Löscht…" : "Löschen"}
              </button>
              <div className="flex-1" />
              <button type="button" onClick={onClose} disabled={saving || deleting} className="kasten kasten-muted">
                Abbrechen
              </button>
              <button type="submit" disabled={saving || deleting} className="kasten kasten-red">
                {saving ? "Speichert…" : "Speichern"}
              </button>
            </div>
          </form>
        )}
      </Modal>
      {ConfirmModalElement}
    </>
  );
}
