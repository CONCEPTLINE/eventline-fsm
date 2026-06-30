"use client";

/**
 * Termine-Sektion fuer Auftrag-Detail-Page. Aus auftraege/[id]/page.tsx
 * extrahiert (war Teil eines >900-Zeilen-Files).
 *
 * Eigene State-Domain: Form, Notify-Modal, Delete-Modal-mit-Code-Bestaetigung.
 * Parent passt nur Daten + onReload-Callback rein.
 */

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { logError } from "@/lib/log";
import { todayLocalIso, localDateIso } from "@/lib/swiss-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { Calendar, Clock, User, Plus, Send, Check, Trash2, AlertTriangle, UserPlus, X, Video } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import type { JobAppointment, Profile, TimeOffType } from "@/types";
import { useTimeOffConflicts, buildConflictMap } from "@/lib/use-time-off-conflicts";
import { toLocalIsoString, todayLocalDateString } from "@/lib/format";
import { calculateForecast, monthRange, forecastStatus } from "@/lib/bvg-forecast";

interface Props {
  jobId: string;
  jobTitle: string | null;
  jobStatus: string;
  jobStartDate: string | null;
  appointments: JobAppointment[];
  profiles: Profile[];
  onReload: () => void;
  /** Wenn true wird das Termin-Form initial offen gerendert (?termin=neu Flow). */
  defaultOpen?: boolean;
}

export function AppointmentsSection({
  jobId,
  jobTitle,
  jobStatus,
  jobStartDate,
  appointments,
  profiles,
  onReload,
  defaultOpen = false,
}: Props) {
  const supabase = createClient();
  const { can } = usePermissions();
  const [showApptForm, setShowApptForm] = useState(defaultOpen);
  const [apptForm, setApptForm] = useState({
    title: "",
    date: todayLocalDateString(),
    time: "09:00",
    end_time: "17:00",
    assigned_to: [] as string[],
    description: "",
    meeting_link: "",
  });
  const [notifiedAppts, setNotifiedAppts] = useState<Set<string>>(new Set());
  const [notifyPopup, setNotifyPopup] = useState<string | null>(null);
  const [emailField1, setEmailField1] = useState("");
  const [emailField2, setEmailField2] = useState("");
  // Inline-Zuweisung pro existierendem Termin (sonst muesste der User
  // den Termin loeschen + neu anlegen um zuzuteilen). assigningId =
  // welcher Termin gerade die Zuweisen-Schublade offen hat. Multi-select:
  // wir behalten eine lokale Auswahl bis der User auf "Anwenden" klickt,
  // dann gleichen wir gegen die DB ab (UPDATE-original + INSERT-Kopien
  // pro zusaetzlichem Mitarbeiter).
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [assigningSelection, setAssigningSelection] = useState<string[]>([]);
  const [assigningBusy, setAssigningBusy] = useState(false);
  // Doppel-Klick-Schutz fuer 'Termin erstellen'-Submit.
  const [addingAppt, setAddingAppt] = useState(false);
  // BVG-Vorwarnung: zeigt Confirm-Modal mit pro-Person-Aufschluesselung
  // wenn Forecast nach Insert >= 95% der Schwelle erreicht.
  const [bvgWarn, setBvgWarn] = useState<null | {
    threshold: number;
    rows: { name: string; current: number; after: number; status: "ok" | "warn" | "crit" }[];
    pending: { startTime: string; endTime: string; assignees: string[]; userId: string | null };
  }>(null);

  function openAssign(apptId: string, currentAssignee: string | null) {
    setAssigningId(apptId);
    setAssigningSelection(currentAssignee ? [currentAssignee] : []);
  }
  function toggleAssignee(profileId: string) {
    setAssigningSelection((prev) => prev.includes(profileId) ? prev.filter((id) => id !== profileId) : [...prev, profileId]);
  }
  const { confirm, ConfirmModalElement } = useConfirm();

  // Ferien-Konflikte am Termin-Datum — Hook gated auf showApptForm
  // (sonst polled das im Hintergrund obwohl das Form geschlossen ist).
  const timeOffConflicts = useTimeOffConflicts(showApptForm ? apptForm.date : null);
  const conflictByUser = buildConflictMap(timeOffConflicts);

  const TYPE_LABEL: Record<TimeOffType, string> = {
    ferien: "Ferien",
    krank: "Krank",
    kompensation: "Kompensation",
    frei: "Frei",
    militaer: "Militär",
  };

  function formatDateShort(iso: string): string {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit" });
  }

  async function addAppointment(e: React.FormEvent) {
    e.preventDefault();
    if (addingAppt) return; // Doppel-Klick-Schutz
    // Meeting-Link, wenn gesetzt, muss http/https sein. Verhindert dass
    // jemand z.B. "teams.microsoft.com/..." ohne Schema einkippt und das
    // dann als relativer Link auf der eigenen Seite landet.
    const meetingLinkRaw = apptForm.meeting_link.trim();
    if (meetingLinkRaw && !/^https?:\/\//i.test(meetingLinkRaw)) {
      toast.error("Meeting-Link muss mit https:// oder http:// beginnen");
      return;
    }
    setAddingAppt(true);
    try {
    const startTime = toLocalIsoString(apptForm.date, apptForm.time || "00:00");
    const endTime = toLocalIsoString(apptForm.date, apptForm.end_time || "17:00");

    const { data: { user } } = await supabase.auth.getUser();
    const assignees = apptForm.assigned_to.length > 0 ? apptForm.assigned_to : [user?.id || ""];

    // BVG-Vorabpruefung: berechne Forecast pro Assignee fuer den Monat
    // in dem der neue Termin liegt. Wenn jemand >= 95% reisst -> Modal.
    const apptDate = apptForm.date;
    const apptYear = Number(apptDate.slice(0, 4));
    const apptMonth = Number(apptDate.slice(5, 7));
    const m = monthRange(apptYear, apptMonth);
    const [settingsRes, compRes, existingRes] = await Promise.all([
      supabase.from("app_settings").select("bvg_threshold_chf").eq("id", 1).maybeSingle(),
      supabase.from("employee_compensation")
        .select("profile_id, hourly_wage_chf, effective_from, effective_to")
        .in("profile_id", assignees.filter(Boolean)),
      supabase.from("job_appointments")
        .select("assigned_to, start_time, end_time")
        .in("assigned_to", assignees.filter(Boolean))
        .gte("start_time", `${m.start}T00:00:00Z`)
        .lt("start_time", `${m.end}T23:59:59Z`),
    ]);
    const threshold = Number(settingsRes.data?.bvg_threshold_chf ?? 1890);
    const today = todayLocalIso();
    type Comp = { profile_id: string; hourly_wage_chf: number; effective_from: string; effective_to: string | null };
    const wagePerProfile = new Map<string, number>();
    for (const c of (compRes.data ?? []) as Comp[]) {
      if (c.effective_from <= today && (!c.effective_to || c.effective_to >= today)) {
        const existing = wagePerProfile.get(c.profile_id);
        if (!existing || (c.effective_from > today)) wagePerProfile.set(c.profile_id, Number(c.hourly_wage_chf));
      }
    }
    type Ex = { assigned_to: string; start_time: string; end_time: string | null };
    const warnRows: { name: string; current: number; after: number; status: "ok" | "warn" | "crit" }[] = [];
    for (const personId of assignees) {
      if (!personId) continue;
      const wage = wagePerProfile.get(personId);
      if (!wage) continue;
      const existing = ((existingRes.data ?? []) as Ex[]).filter((r) => r.assigned_to === personId).map((r) => ({ start_time: r.start_time, end_time: r.end_time }));
      const current = calculateForecast(existing, wage, m.start, m.end).total_chf;
      const after = calculateForecast([...existing, { start_time: startTime, end_time: endTime }], wage, m.start, m.end).total_chf;
      const status = forecastStatus(after, threshold);
      if (status !== "ok") {
        const p = profiles.find((x) => x.id === personId);
        warnRows.push({ name: p?.full_name || "Unbekannt", current, after, status });
      }
    }
    if (warnRows.length > 0) {
      setAddingAppt(false);
      setBvgWarn({ threshold, rows: warnRows, pending: { startTime, endTime, assignees, userId: user?.id ?? null } });
      return;
    }

    await persistAppointment(startTime, endTime, assignees, user?.id ?? null);
    return;
    } finally {
      setAddingAppt(false);
    }
  }

  async function persistAppointment(startTime: string, endTime: string, assignees: string[], userId: string | null) {
    const meetingLink = apptForm.meeting_link.trim() || null;
    const rows = assignees.map((personId) => ({
      job_id: jobId,
      title: apptForm.title,
      start_time: startTime,
      end_time: endTime,
      assigned_to: personId,
      description: apptForm.description || null,
      meeting_link: meetingLink,
    }));
    await supabase.from("job_appointments").insert(rows);

    // E-Mail an zugewiesene Personen (ausser self)
    const { data: creator } = await supabase.from("profiles").select("full_name").eq("id", userId ?? "").maybeSingle();
    for (const personId of assignees) {
      if (personId && personId !== userId) {
        try {
          await fetch("/api/appointments/assign-notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              assignedTo: personId,
              title: apptForm.title,
              date: apptForm.date,
              time: apptForm.time,
              endTime: apptForm.end_time,
              jobTitle: jobTitle ?? null,
              creatorName: creator?.full_name || "Unbekannt",
            }),
          });
        } catch (e) {
          logError("auftrag.appt.assign-notify", e, { personId, jobId });
        }
      }
    }

    setApptForm({
      title: "",
      date: todayLocalDateString(),
      time: "09:00",
      end_time: "17:00",
      assigned_to: [],
      description: "",
      meeting_link: "",
    });
    setShowApptForm(false);
    onReload();
    toast.success(`Termin für ${assignees.length} Person${assignees.length > 1 ? "en" : ""} erstellt`);
  }

  async function confirmBvgAndProceed() {
    if (!bvgWarn) return;
    const { pending } = bvgWarn;
    setAddingAppt(true);
    try {
      await persistAppointment(pending.startTime, pending.endTime, pending.assignees, pending.userId);
      setBvgWarn(null);
    } finally {
      setAddingAppt(false);
    }
  }

  // useConfirm-Pattern statt vorherigem hardcoded Code "5225"-Modal —
  // konsistent mit allen anderen Loesch-Flows app-weit.
  async function applyAssignment(apptId: string) {
    const appt = appointments.find((a) => a.id === apptId);
    if (!appt) return;
    setAssigningBusy(true);
    const selection = assigningSelection;
    const previousAssignee = appt.assigned_to;

    try {
      if (selection.length === 0) {
        // Keiner mehr zugewiesen -> Original-Row auf null setzen
        const { error } = await supabase
          .from("job_appointments")
          .update({ assigned_to: null })
          .eq("id", apptId);
        if (error) throw error;
        toast.success("Zuweisung entfernt");
      } else {
        // Erste Person bekommt den Original-Row (UPDATE), zusaetzliche
        // bekommen Kopien (INSERT). So zaehlt der ursprueng-Termin
        // weiter und wir vermeiden Dublikate des urspruenglichen.
        const [first, ...rest] = selection;
        const { error: upErr } = await supabase
          .from("job_appointments")
          .update({ assigned_to: first })
          .eq("id", apptId);
        if (upErr) throw upErr;
        if (rest.length > 0) {
          const rows = rest.map((personId) => ({
            job_id: jobId,
            title: appt.title,
            start_time: appt.start_time,
            end_time: appt.end_time,
            description: appt.description,
            assigned_to: personId,
          }));
          const { error: insErr } = await supabase.from("job_appointments").insert(rows);
          if (insErr) throw insErr;
        }
        toast.success(selection.length === 1 ? "Termin zugewiesen" : `${selection.length} Personen zugewiesen`);
      }

      // Mail an die NEU zugewiesenen Personen (vorher waren sie nicht
      // assignee dieses Rows). Bei mehreren neuen -> mehrere Mails.
      const { data: { user } } = await supabase.auth.getUser();
      const newAssignees = selection.filter((id) => id !== previousAssignee && id !== user?.id);
      if (newAssignees.length > 0) {
        const { data: creator } = await supabase.from("profiles").select("full_name").eq("id", user?.id ?? "").maybeSingle();
        // ZRH-Datum/Zeit zwingend — sonst zeigt die Benachrichtigung den
        // UTC-Tag bei Terminen kurz nach Mitternacht.
        const apptDate = localDateIso(new Date(appt.start_time));
        const apptTime = new Date(appt.start_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hour12: false });
        const apptEnd = appt.end_time ? new Date(appt.end_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
        for (const personId of newAssignees) {
          try {
            await fetch("/api/appointments/assign-notify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                assignedTo: personId,
                title: appt.title,
                date: apptDate,
                time: apptTime,
                endTime: apptEnd,
                jobTitle: jobTitle ?? null,
                creatorName: creator?.full_name || "Unbekannt",
              }),
            });
          } catch (e) {
            logError("auftrag.appt.reassign-notify", e, { personId, apptId });
          }
        }
      }

      setAssigningId(null);
      setAssigningSelection([]);
      onReload();
    } catch (e) {
      TOAST.supabaseError(e as Parameters<typeof TOAST.supabaseError>[0], "Zuweisung konnte nicht gespeichert werden");
    } finally {
      setAssigningBusy(false);
    }
  }

  async function deleteAppointment(apptId: string) {
    const ok = await confirm({
      title: "Termin löschen?",
      message: "Der Termin wird unwiderruflich gelöscht. Die Mitarbeiter-Zuweisung verschwindet ebenfalls.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const result = await deleteRow("job_appointments", apptId);
    if (!result.ok) {
      toast.error(result.error ?? "Termin konnte nicht gelöscht werden");
      return;
    }
    onReload();
    toast.success("Termin gelöscht");
  }

  async function notifyAppointment(apptId: string) {
    const emails = [emailField1, emailField2].filter((e) => e.trim() && e.includes("@"));
    if (emails.length === 0) {
      toast.error("Mindestens eine E-Mail eingeben");
      return;
    }
    toast.info("E-Mails werden gesendet...");
    try {
      const res = await fetch("/api/appointments/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: apptId, job_id: jobId, send_to_emails: emails }),
      });
      const result = await res.json();
      if (result.sentTo?.length > 0) {
        toast.success(`E-Mail gesendet an: ${result.sentTo.join(", ")}`);
        setNotifiedAppts((prev) => new Set(prev).add(apptId));
      } else {
        toast.error("Keine E-Mails gesendet");
      }
    } catch (e) {
      logError("auftrag.appt.notify", e, { apptId, jobId });
      TOAST.sendError();
    }
    setNotifyPopup(null);
    setEmailField1("");
    setEmailField2("");
  }

  const isClosed = ["abgeschlossen", "storniert"].includes(jobStatus);

  return (
    <>
      <Card id="termin-form" className="bg-card scroll-mt-4">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Calendar className="h-4 w-4" />Termine ({appointments.length})
          </CardTitle>
          {!isClosed && can("kalender:create") && (
            <button type="button" onClick={() => setShowApptForm(!showApptForm)} className="kasten kasten-blue">
              <Plus className="h-3.5 w-3.5" />Termin
            </button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {showApptForm && !isClosed && (
            <form onSubmit={addAppointment} className="p-4 rounded-xl bg-foreground/[0.03] border border-foreground/10 dark:bg-foreground/5 dark:border-foreground/15 space-y-3">
              <Input placeholder="Termin-Titel *" value={apptForm.title} onChange={(e) => setApptForm({ ...apptForm, title: e.target.value })} required />
              <div className="grid grid-cols-3 gap-3">
                <div><label className="text-xs font-medium">Datum *</label><Input type="date" value={apptForm.date} onChange={(e) => setApptForm({ ...apptForm, date: e.target.value })} className="mt-1" required /></div>
                <div><label className="text-xs font-medium">Von *</label><Input type="time" value={apptForm.time} onChange={(e) => setApptForm({ ...apptForm, time: e.target.value })} className="mt-1" required /></div>
                <div><label className="text-xs font-medium">Bis *</label><Input type="time" value={apptForm.end_time} onChange={(e) => setApptForm({ ...apptForm, end_time: e.target.value })} className="mt-1" required /></div>
              </div>
              <div>
                <label className="text-xs font-medium">Zuweisen an {apptForm.assigned_to.length > 0 && <span className="text-muted-foreground">({apptForm.assigned_to.length})</span>}</label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {profiles.map((p) => {
                    const selected = apptForm.assigned_to.includes(p.id);
                    const conflict = conflictByUser.get(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setApptForm({ ...apptForm, assigned_to: selected ? apptForm.assigned_to.filter((pid) => pid !== p.id) : [...apptForm.assigned_to, p.id] })}
                        className={selected ? "kasten-active" : "kasten-toggle-off"}
                        title={conflict ? `${TYPE_LABEL[conflict.type]} ${formatDateShort(conflict.start_date)}–${formatDateShort(conflict.end_date)} (${conflict.status})` : undefined}
                      >
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${selected ? "bg-background/20" : "bg-foreground/10 text-muted-foreground"}`}>
                          {p.full_name.charAt(0)}
                        </div>
                        {p.full_name.split(" ")[0]}
                        {conflict && (
                          <AlertTriangle
                            className={`h-3.5 w-3.5 ${conflict.status === "genehmigt" ? "text-red-500" : "text-amber-500"}`}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
                {apptForm.assigned_to.length === 0 && <p className="text-[11px] text-muted-foreground mt-1">Keine Auswahl = mir selbst</p>}

                {/* Konflikt-Liste: zeigt JEDEN User mit Konflikt am Datum,
                    nicht nur die selektierten — hilft beim Auswaehlen. */}
                {timeOffConflicts.length > 0 && (
                  <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2">
                    <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-200 mb-1">
                      Abwesend am {formatDateShort(apptForm.date)}
                    </p>
                    <ul className="space-y-0.5 text-[11px] text-amber-900 dark:text-amber-200">
                      {timeOffConflicts.map((c) => {
                        const isSelected = apptForm.assigned_to.includes(c.user_id);
                        return (
                          <li key={c.id} className="flex items-center gap-1.5">
                            <AlertTriangle className={`h-3 w-3 shrink-0 ${c.status === "genehmigt" ? "text-red-500" : "text-amber-500"}`} />
                            <span className={isSelected ? "font-semibold" : ""}>
                              {c.user?.full_name ?? "Unbekannt"}
                            </span>
                            <span className="opacity-75">
                              · {TYPE_LABEL[c.type]} {formatDateShort(c.start_date)}–{formatDateShort(c.end_date)}
                              {c.status === "beantragt" ? " (Antrag offen)" : ""}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
              <textarea placeholder="Beschreibung..." value={apptForm.description} onChange={(e) => setApptForm({ ...apptForm, description: e.target.value })} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-ring/40" rows={2} style={{ fieldSizing: "content" } as React.CSSProperties} />
              <div className="relative">
                <Video className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  type="url"
                  placeholder="Meeting-Link (optional) — z.B. https://teams.microsoft.com/..."
                  value={apptForm.meeting_link}
                  onChange={(e) => setApptForm({ ...apptForm, meeting_link: e.target.value })}
                  className="pl-9"
                />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowApptForm(false)} className="kasten kasten-muted">Abbrechen</button>
                <button type="submit" disabled={addingAppt} className="kasten kasten-red">{addingAppt ? "Speichere…" : "Termin erstellen"}</button>
              </div>
            </form>
          )}
          {appointments.length === 0 && !showApptForm && (
            !isClosed ? (
              <div className="flex items-center gap-3 p-3 rounded-xl border tinted-amber">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/20 shrink-0">
                  <Calendar className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Kein Termin geplant</p>
                  <p className="text-xs opacity-80 mt-0.5">
                    {jobStartDate ? (() => {
                      const days = Math.ceil((new Date(jobStartDate).getTime() - Date.now()) / 86400000);
                      return days > 0 ? `Auftrag beginnt in ${days} Tag${days === 1 ? "" : "en"}` : days === 0 ? "Auftrag beginnt heute" : `Auftrag hat vor ${Math.abs(days)} Tag${Math.abs(days) === 1 ? "" : "en"} begonnen`;
                    })() : "Kein Startdatum gesetzt"}
                    {" · oben rechts \"Termin\" anlegen"}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-2">Keine Termine.</p>
            )
          )}
          {appointments.map((appt) => {
            const assignee = appt.assignee;
            const isAssigning = assigningId === appt.id;
            const unassigned = !appt.assigned_to;
            return (
              <div key={appt.id} className="rounded-xl border bg-foreground/[0.02] border-foreground/10 dark:bg-foreground/[0.04] dark:border-foreground/15">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {/* Rundes Video-Icon ganz links — Direkt-Join-Knopf.
                      Nur sichtbar wenn meeting_link gesetzt; ein Klick =
                      neuer Tab mit dem Meeting. */}
                  {appt.meeting_link && (
                    <a
                      href={appt.meeting_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="w-9 h-9 rounded-full bg-blue-500 hover:bg-blue-600 flex items-center justify-center shrink-0 transition-all hover:scale-110 shadow-sm"
                      data-tooltip={`Meeting beitreten · ${appt.meeting_link}`}
                      aria-label="Meeting beitreten"
                    >
                      <Video className="h-4 w-4 text-white" />
                    </a>
                  )}
                  <div className="min-w-0">
                    <span className="font-medium text-sm break-words">{appt.title}</span>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(appt.start_time).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}{appt.end_time ? ` – ${new Date(appt.end_time).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}` : ""}</span>
                      {assignee ? (
                        <span className="flex items-center gap-1"><User className="h-3 w-3" />{assignee.full_name}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300 font-medium"><UserPlus className="h-3 w-3" />Nicht zugewiesen</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                  {/* Termin-Bestaetigungs-Mail nur wenn Auftrag noch aktiv —
                      bei abgeschlossenen/stornierten Auftraegen ergibt eine
                      Termin-Erinnerung keinen Sinn. */}
                  {!isClosed && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setNotifyPopup(notifyPopup === appt.id ? null : appt.id)}
                        className={`kasten ${notifiedAppts.has(appt.id) ? "kasten-green" : "kasten-blue"}`}
                      >
                        {notifiedAppts.has(appt.id) ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
                        {notifiedAppts.has(appt.id) ? "Gesendet" : "Benachrichtigen"}
                      </button>
                      <Modal
                        open={notifyPopup === appt.id}
                        onClose={() => { setNotifyPopup(null); setEmailField1(""); setEmailField2(""); }}
                        title="Terminbestätigung senden"
                        icon={<Send className="h-5 w-5 text-blue-500" />}
                        size="md"
                      >
                        <div>
                          <label className="text-sm font-medium">E-Mail 1 *</label>
                          <Input
                            type="email"
                            value={emailField1}
                            onChange={(e) => setEmailField1(e.target.value)}
                            placeholder="empfaenger@beispiel.ch"
                            className="mt-1.5"
                          />
                        </div>
                        <div>
                          <label className="text-sm font-medium">E-Mail 2 (optional)</label>
                          <Input
                            type="email"
                            value={emailField2}
                            onChange={(e) => setEmailField2(e.target.value)}
                            placeholder="weitere@beispiel.ch"
                            className="mt-1.5"
                          />
                        </div>
                        <div className="flex gap-3 pt-2">
                          <button type="button" onClick={() => { setNotifyPopup(null); setEmailField1(""); setEmailField2(""); }} className="kasten kasten-muted flex-1">
                            Abbrechen
                          </button>
                          <button type="button" onClick={() => notifyAppointment(appt.id)} className="kasten kasten-blue flex-1">
                            <Send className="h-3.5 w-3.5" />Senden
                          </button>
                        </div>
                      </Modal>
                    </div>
                  )}
                  {!isClosed && can("kalender:create") && (
                    <button
                      type="button"
                      onClick={() => isAssigning ? setAssigningId(null) : openAssign(appt.id, appt.assigned_to)}
                      className={`kasten ${unassigned ? "kasten-red" : "kasten-muted"}`}
                      data-tooltip={unassigned ? "Termin zuweisen" : "Zuweisung ändern"}
                    >
                      {isAssigning ? <X className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                      {unassigned ? "Zuweisen" : "Ändern"}
                    </button>
                  )}
                  {!isClosed && can("kalender:delete") && (
                    <button
                      type="button"
                      onClick={() => deleteAppointment(appt.id)}
                      className="kasten kasten-red"
                      data-tooltip="Termin löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Löschen
                    </button>
                  )}
                </div>
              </div>
              {/* Inline-Zuweisungs-Schublade — Multi-Select.
                  Erste Person uebernimmt den Original-Row, weitere
                  bekommen eigene Termin-Zeile (gleiche Zeit, gleicher
                  Titel, andere assigned_to). */}
              {isAssigning && !isClosed && can("kalender:create") && (
                <div className="px-3 pb-3 border-t border-foreground/10 dark:border-foreground/15 pt-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                    Zuweisen an {assigningSelection.length > 0 && <span className="text-muted-foreground">({assigningSelection.length})</span>}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {profiles.map((p) => {
                      const selected = assigningSelection.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          disabled={assigningBusy}
                          onClick={() => toggleAssignee(p.id)}
                          className={selected ? "kasten-active" : "kasten-toggle-off"}
                        >
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${selected ? "bg-background/20" : "bg-foreground/10 text-muted-foreground"}`}>
                            {p.full_name.charAt(0)}
                          </div>
                          {p.full_name.split(" ")[0]}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 mt-2.5">
                    <p className="text-[11px] text-muted-foreground flex-1">
                      Mehrere möglich — jede zusätzliche Person bekommt eine eigene Termin-Zeile.
                    </p>
                    <button
                      type="button"
                      onClick={() => { setAssigningId(null); setAssigningSelection([]); }}
                      disabled={assigningBusy}
                      className="kasten kasten-muted"
                    >
                      Abbrechen
                    </button>
                    <button
                      type="button"
                      onClick={() => applyAssignment(appt.id)}
                      disabled={assigningBusy}
                      className="kasten kasten-blue"
                    >
                      {assigningBusy ? "Speichern…" : "Anwenden"}
                    </button>
                  </div>
                </div>
              )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {ConfirmModalElement}

      <Modal
        open={bvgWarn !== null}
        onClose={() => setBvgWarn(null)}
        title="BVG-Eintrittsschwelle erreicht"
        icon={<AlertTriangle className="h-5 w-5 text-red-500" />}
        size="md"
      >
        {bvgWarn && (
          <div className="space-y-3">
            <p className="text-sm">
              Mit diesem Termin verdienen folgende Personen brutto mehr als die hinterlegte BVG-Schwelle von <strong>{bvgWarn.threshold.toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF</strong> pro Monat. Sie würden damit BVG-pflichtig.
            </p>
            <div className="space-y-1">
              {bvgWarn.rows.map((r) => (
                <div key={r.name} className={`p-2 rounded-lg border text-xs ${r.status === "crit" ? "bg-red-500/10 border-red-500/40" : "bg-amber-500/10 border-amber-500/40"}`}>
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold">{r.name}</span>
                    <span className="tabular-nums font-bold">
                      {Math.round(r.current).toLocaleString("de-CH")} → {Math.round(r.after).toLocaleString("de-CH")} CHF
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5">
                    {r.status === "crit" ? "Über der Schwelle." : "Knapp unter der Schwelle (Warnzone)."}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <button type="button" onClick={() => setBvgWarn(null)} className="kasten kasten-muted">
                Abbrechen
              </button>
              <button type="button" onClick={confirmBvgAndProceed} disabled={addingAppt} className="kasten kasten-red">
                {addingAppt ? "Erstellt…" : "Trotzdem erstellen"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
