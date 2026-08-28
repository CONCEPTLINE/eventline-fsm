"use client";

/**
 * Termin-Sektion auf der Projekt-Detailseite.
 *
 * Termine liegen in job_appointments mit project_id — NICHT in einer
 * eigenen Tabelle. Dadurch erscheinen sie ohne Sonderbehandlung im
 * Kalender, im iCal-Feed und in allen bestehenden Termin-Auswertungen.
 * Siehe Migration 190.
 *
 * Berechtigung kommt aus der RLS (can_access_project): wer das Projekt
 * sehen darf, darf dessen Termine verwalten — auch ohne kalender:create.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { SearchableSelect } from "@/components/searchable-select";
import { useConfirm } from "@/components/ui/use-confirm";
import { CalendarDays, Plus, Loader2, X, AlertTriangle, Video } from "lucide-react";
import { toast } from "sonner";
import { logError } from "@/lib/log";
import { toLocalIsoString } from "@/lib/format";

interface Termin {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  meeting_link: string | null;
  assigned_to: string | null;
  assignee?: { full_name: string | null } | null;
}

interface ProfileRow {
  id: string;
  full_name: string | null;
}

interface Props {
  projectId: string;
  /** Projekt-Zeitraum — nur fuer Vorbelegung und Hinweis, keine Sperre. */
  startDate: string | null;
  endDate: string | null;
  /** Anlegen/Loeschen ausblenden wenn das Projekt im Archiv liegt. */
  readOnly: boolean;
}

/** "YYYY-MM-DD" aus einem Date im lokalen Kalender. */
function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const TIME_FMT: Intl.DateTimeFormatOptions = {
  timeZone: "Europe/Zurich",
  hour: "2-digit",
  minute: "2-digit",
};

export function ProjektTermine({ projectId, startDate, endDate, readOnly }: Props) {
  const supabase = createClient();
  const [termine, setTermine] = useState<Termin[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("job_appointments")
      .select("id, title, description, start_time, end_time, meeting_link, assigned_to, assignee:profiles!assigned_to(full_name)")
      .eq("project_id", projectId)
      .order("start_time", { ascending: true });
    if (error) {
      logError("projekte.termine.load", error);
      setLoading(false);
      return;
    }
    setTermine((data ?? []).map((t) => ({
      ...t,
      assignee: Array.isArray(t.assignee) ? t.assignee[0] : t.assignee,
    })) as Termin[]);
    setLoading(false);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  async function remove(t: Termin) {
    const ok = await confirm({
      title: "Termin löschen?",
      message: `„${t.title}“ wird auch aus dem Kalender entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("job_appointments").delete().eq("id", t.id);
    if (error) { toast.error("Löschen fehlgeschlagen: " + error.message); return; }
    toast.success("Termin gelöscht");
    load();
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <CalendarDays className="h-3 w-3" /> Termine ({termine.length})
        </p>
        {!readOnly && (
          <button onClick={() => setModalOpen(true)} className="kasten kasten-muted">
            <Plus className="h-3.5 w-3.5" /> Termin
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground p-2">Lädt…</p>
      ) : termine.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-xs text-muted-foreground text-center">
            Noch keine Termine. Angelegte Termine erscheinen automatisch im Kalender.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1">
          {termine.map((t) => {
            const start = new Date(t.start_time);
            const day = toLocalDateString(start);
            // Hinweis statt Sperre: Vorbesichtigungen und Nachbesprechungen
            // liegen legitim ausserhalb des geplanten Zeitraums.
            const outside =
              (startDate != null && day < startDate) || (endDate != null && day > endDate);
            return (
              <Card key={t.id}>
                <CardContent className="p-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{t.title}</span>
                      {outside && (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400"
                          data-tooltip="Liegt ausserhalb des Projektzeitraums"
                        >
                          <AlertTriangle className="h-3 w-3" /> ausserhalb
                        </span>
                      )}
                      {t.meeting_link && (
                        <a
                          href={t.meeting_link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          aria-label="Meeting öffnen"
                        >
                          <Video className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {start.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}
                      {" · "}
                      {start.toLocaleTimeString("de-CH", TIME_FMT)}
                      {t.end_time && ` – ${new Date(t.end_time).toLocaleTimeString("de-CH", TIME_FMT)}`}
                      {t.assignee?.full_name && ` · ${t.assignee.full_name}`}
                    </p>
                    {t.description && (
                      <p className="text-[12px] text-muted-foreground truncate">{t.description}</p>
                    )}
                  </div>
                  {!readOnly && (
                    <button
                      onClick={() => remove(t)}
                      className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                      aria-label="Termin löschen"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <NeuerProjektTerminModal
          projectId={projectId}
          startDate={startDate}
          endDate={endDate}
          onClose={() => setModalOpen(false)}
          onCreated={() => { setModalOpen(false); load(); }}
        />
      )}
      {ConfirmModalElement}
    </div>
  );
}

/** Anlege-Modal. Bewusst schlanker als der Kalender-Modal: kein
 *  Auftrag-Picker (das Projekt IST der Bezug) und ein Zuweisungs-Feld
 *  statt Mehrfachauswahl — auf einem internen Projekt arbeitet in aller
 *  Regel eine Person. */
function NeuerProjektTerminModal({
  projectId,
  startDate,
  endDate,
  onClose,
  onCreated,
}: {
  projectId: string;
  startDate: string | null;
  endDate: string | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const supabase = createClient();
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [title, setTitle] = useState("");
  // Vorbelegung: Projektstart, sofern er nicht in der Vergangenheit liegt —
  // sonst heute. Spart bei laufenden Projekten das Zurueckblaettern.
  const [date, setDate] = useState(() => {
    const today = toLocalDateString(new Date());
    if (startDate && startDate > today) return startDate;
    return today;
  });
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [assignedTo, setAssignedTo] = useState("");
  const [description, setDescription] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) setAssignedTo(user.id);
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("is_active", true)
        .neq("role", "partner")
        .order("full_name");
      setProfiles((data ?? []) as ProfileRow[]);
    })();
  }, [supabase]);

  const outsideRange = useMemo(
    () => (startDate != null && date < startDate) || (endDate != null && date > endDate),
    [date, startDate, endDate],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return toast.error("Titel fehlt");
    if (endTime < startTime) return toast.error("Ende liegt vor dem Start");
    const link = meetingLink.trim();
    if (link && !/^https?:\/\//i.test(link)) {
      return toast.error("Meeting-Link muss mit https:// oder http:// beginnen");
    }

    setSaving(true);
    const { error } = await supabase.from("job_appointments").insert({
      project_id: projectId,
      // Bewusst null: ein Projekt-Termin haengt an keinem Auftrag.
      job_id: null,
      title: title.trim(),
      start_time: toLocalIsoString(date, startTime),
      end_time: toLocalIsoString(date, endTime),
      assigned_to: assignedTo || null,
      description: description.trim() || null,
      meeting_link: link || null,
    });
    setSaving(false);
    if (error) {
      logError("projekte.termine.create", error);
      toast.error("Termin konnte nicht erstellt werden: " + error.message);
      return;
    }
    toast.success("Termin erstellt");
    onCreated();
  }

  return (
    <Modal open onClose={() => { if (!saving) onClose(); }} title="Neuer Projekt-Termin" size="md" closable={!saving}>
      <form onSubmit={submit} className="space-y-4">
        <Input placeholder="Termin-Titel *" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium">Datum *</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" required />
          </div>
          <div>
            <label className="text-xs font-medium">Von *</label>
            <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="mt-1" required />
          </div>
          <div>
            <label className="text-xs font-medium">Bis *</label>
            <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="mt-1" required />
          </div>
        </div>

        {outsideRange && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-900 dark:text-amber-200">
              Der Termin liegt ausserhalb des Projektzeitraums. Das ist erlaubt — z.B. für Vor- oder Nachbesprechungen.
            </p>
          </div>
        )}

        <div>
          <label className="text-xs font-medium">Zuweisen an</label>
          <div className="mt-1.5">
            <SearchableSelect
              value={assignedTo}
              onChange={(v) => setAssignedTo(v ?? "")}
              items={profiles.map((p) => ({ id: p.id, label: p.full_name ?? "—" }))}
              placeholder="Mitarbeiter wählen"
              searchable
            />
          </div>
        </div>

        <textarea
          placeholder="Beschreibung…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full px-3 py-2 text-sm rounded-lg border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
        />

        <div className="relative">
          <Video className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            type="url"
            placeholder="Meeting-Link (optional)"
            value={meetingLink}
            onChange={(e) => setMeetingLink(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={saving} className="kasten kasten-muted flex-1">
            Abbrechen
          </button>
          <button type="submit" disabled={saving} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {saving ? "Speichert…" : "Termin erstellen"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
