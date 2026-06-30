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
import { Loading } from "@/components/ui/spinner";
import { useConfirm } from "@/components/ui/use-confirm";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { logError } from "@/lib/log";
import { Trash2, User, Mail, Check, Video } from "lucide-react";
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
  meeting_link: string | null;
  job_id: string | null;
  assigned_to: string;
  assignee: { full_name: string } | null;
  customer_email: string | null;
  customer_name: string | null;
  confirmation_sent_at: string | null;
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
  const [meetingLink, setMeetingLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Confirm-Send-State
  const [showConfirm, setShowConfirm] = useState(false);
  const [confEmail, setConfEmail] = useState("");
  const [confName, setConfName] = useState("");
  const [confMessage, setConfMessage] = useState("");
  const [confSending, setConfSending] = useState(false);

  const open = apptId !== null;

  // Beim Oeffnen: Termin laden + Form-State befuellen.
  useEffect(() => {
    if (!apptId) return;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from("job_appointments")
        .select("id, title, start_time, end_time, description, meeting_link, job_id, assigned_to, customer_email, customer_name, confirmation_sent_at, assignee:profiles!assigned_to(full_name)")
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
      setMeetingLink(row.meeting_link ?? "");
      setConfEmail(row.customer_email ?? "");
      setConfName(row.customer_name ?? "");
      setConfMessage("");
      setLoading(false);
    })();
  }, [apptId, supabase, onClose]);

  async function sendConfirmation() {
    if (!appt) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(confEmail.trim())) {
      toast.error("Bitte gueltige Email-Adresse eingeben");
      return;
    }
    setConfSending(true);
    try {
      const res = await fetch(`/api/appointments/${appt.id}/send-confirmation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_email: confEmail.trim(),
          customer_name: confName.trim() || undefined,
          custom_message: confMessage.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error || "Versand fehlgeschlagen");
        return;
      }
      toast.success(`Bestaetigung an ${confEmail.trim()} gesendet`);
      // Termin-State im Modal aktualisieren damit die Status-Pille
      // gleich sichtbar wird ohne Reload.
      setAppt((prev) => prev ? {
        ...prev,
        customer_email: confEmail.trim(),
        customer_name: confName.trim() || null,
        confirmation_sent_at: new Date().toISOString(),
      } : prev);
      setShowConfirm(false);
      onChanged();
    } finally {
      setConfSending(false);
    }
  }

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
    const meetingLinkClean = meetingLink.trim();
    if (meetingLinkClean && !/^https?:\/\//i.test(meetingLinkClean)) {
      toast.error("Meeting-Link muss mit https:// oder http:// beginnen");
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
          meeting_link: meetingLinkClean || null,
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
          <Loading />
        ) : (
          <form onSubmit={save} className="space-y-4">
            {/* Wenn Meeting-Link gespeichert ist: prominenter Direkt-Join-
                Button ganz oben — mit einem Klick rein ins Meeting, ohne
                erst zu scrollen oder das Feld zu kopieren. */}
            {appt.meeting_link && (
              <a
                href={appt.meeting_link}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/15 transition-colors group"
                data-tooltip={appt.meeting_link}
              >
                <div className="w-9 h-9 rounded-full bg-blue-500 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                  <Video className="h-4 w-4 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-blue-700 dark:text-blue-300">Meeting beitreten</p>
                  <p className="text-[11px] text-muted-foreground truncate">{appt.meeting_link.replace(/^https?:\/\//, "")}</p>
                </div>
              </a>
            )}

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

            <div>
              <label className="text-xs font-medium text-muted-foreground">Meeting-Link (optional)</label>
              <div className="relative mt-1">
                <Video className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  type="url"
                  placeholder="z.B. https://teams.microsoft.com/..."
                  value={meetingLink}
                  onChange={(e) => setMeetingLink(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            {/* Termin-Bestaetigung an Kunde — auch fuer Termine mit Job
                erlaubt (manchmal will man Kunde separat informieren ueber
                eine Begehung etc.). */}
            <div className="rounded-lg border border-border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Bestaetigung an Kunde</span>
                {appt.confirmation_sent_at && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                    <Check className="h-2.5 w-2.5" />gesendet
                  </span>
                )}
              </div>
              {appt.confirmation_sent_at && (
                <p className="text-[11px] text-muted-foreground">
                  Letzter Versand am {new Date(appt.confirmation_sent_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                  {appt.customer_email && <> an <span className="font-medium text-foreground/80">{appt.customer_email}</span></>}
                </p>
              )}
              <button
                type="button"
                onClick={() => setShowConfirm(true)}
                className="kasten kasten-blue"
                disabled={saving || deleting}
              >
                <Mail className="h-3.5 w-3.5" />
                {appt.confirmation_sent_at ? "Nochmals senden" : "Bestaetigung senden"}
              </button>
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

      <Modal
        open={showConfirm}
        onClose={() => !confSending && setShowConfirm(false)}
        title="Bestaetigung an Kunde senden"
        icon={<Mail className="h-4 w-4 text-blue-600" />}
        size="md"
        closable={!confSending}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Sendet eine HTML-Email mit Termin-Datum + Uhrzeit + Titel +
            Beschreibung an die angegebene Adresse. Email + Name werden
            am Termin gespeichert (fuer das naechste Mal).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Email *</label>
              <Input type="email" value={confEmail} onChange={(e) => setConfEmail(e.target.value)} placeholder="kunde@beispiel.ch" className="mt-1" required disabled={confSending} />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Name (Anrede)</label>
              <Input value={confName} onChange={(e) => setConfName(e.target.value)} placeholder="Herr Muster" className="mt-1" disabled={confSending} />
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Persoenliche Nachricht (optional)</label>
            <textarea
              value={confMessage}
              onChange={(e) => setConfMessage(e.target.value)}
              rows={3}
              placeholder="z.B. 'Bitte bringen Sie die Plaene mit.'"
              className="mt-1 w-full px-3 py-2 text-sm rounded-lg border bg-card resize-none"
              disabled={confSending}
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => setShowConfirm(false)} className="kasten kasten-muted flex-1" disabled={confSending}>Abbrechen</button>
            <button type="button" onClick={sendConfirmation} className="kasten kasten-red flex-1" disabled={confSending}>
              <Mail className="h-3.5 w-3.5" />{confSending ? "Sendet…" : "Senden"}
            </button>
          </div>
        </div>
      </Modal>

      {ConfirmModalElement}
    </>
  );
}
