"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Calendar, Clock, Plus, Trash2, StickyNote, Check, XCircle, AlertCircle, FileText, Upload, Eye, Download, Pencil, Send } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { useConfirm } from "@/components/ui/use-confirm";
import { toLocalIsoString } from "@/lib/format";
import { validateFileList } from "@/lib/file-upload";
import { PdfPopup } from "@/components/pdf-popup";

interface AnfrageDetail {
  id: string;
  job_number: number | null;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  notes: string | null;
  partner_response_message: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
}

interface Termin {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  description: string | null;
}

interface DocRow {
  id: string;
  name: string;
  storage_path: string;
  file_size: number | null;
  created_at: string;
}

export default function PartnerAnfrageDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();

  const [job, setJob] = useState<AnfrageDetail | null>(null);
  const [termine, setTermine] = useState<Termin[]>([]);
  const [documents, setDocuments] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notesText, setNotesText] = useState("");
  const [savedNotesText, setSavedNotesText] = useState("");
  const [showTerminForm, setShowTerminForm] = useState(false);
  const [terminForm, setTerminForm] = useState({ title: "", date: "", time: "", end_time: "", description: "" });
  const [savingTermin, setSavingTermin] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Strukturelle Aktionen (Termin hinzufuegen/loeschen, Anfrage zurueckziehen)
  // sind verfuegbar solange die Anfrage noch beim Partner liegt
  // (partner_entwurf, partner_anfrage). Nach EVENTLINE-Annahme gesperrt.
  const isEditable = job ? (job.status === "partner_entwurf" || job.status === "partner_anfrage") : false;
  const isReadOnly = !isEditable;
  // Notizen und Dokumente bleiben kollaborativ — auch nach Annahme darf
  // der Partner noch nachreichen (z.B. geaenderter Ablauf, neue Files).
  // Bei "abgeschlossen"/"storniert" ist die Beziehung zu Ende → keine
  // Aenderungen mehr.
  const canEditNotesAndDocs = job ? (job.status === "partner_entwurf" || job.status === "partner_anfrage" || job.status === "offen") : false;
  // Absende-Button nur bei Entwurf + min. 1 Termin sichtbar.
  const isDraft = job?.status === "partner_entwurf";
  const canSubmit = isDraft && termine.length > 0;
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadAll() {
    const [jobRes, termineRes, docsRes] = await Promise.all([
      supabase
        .from("jobs")
        .select("id, job_number, title, description, start_date, end_date, status, notes, partner_response_message, accepted_at, rejected_at, contact_person, contact_phone, contact_email")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("job_appointments")
        .select("id, title, start_time, end_time, description")
        .eq("job_id", id)
        .order("start_time"),
      supabase
        .from("documents")
        .select("id, name, storage_path, file_size, created_at")
        .eq("job_id", id)
        .order("created_at", { ascending: false }),
    ]);
    if (jobRes.error || !jobRes.data) {
      toast.error("Anfrage nicht gefunden");
      router.push("/partner/anfragen");
      return;
    }
    setJob(jobRes.data as AnfrageDetail);
    // Notizen-Parser: ältere Aufträge tragen das Firmenportal-_notes-JSON
    // (`{"_notes":[{content,author,created_at}, ...]}`) als String. Wir
    // joinen die Inhalte zu einem Plain-Text-Block (gleiche Logik wie im
    // Firmenportal /auftraege/[id]). Plain-Text bleibt as-is.
    let initialNotes = "";
    if (jobRes.data.notes) {
      try {
        const parsed = JSON.parse(jobRes.data.notes);
        if (parsed && Array.isArray(parsed._notes)) {
          initialNotes = parsed._notes.map((n: { content: string }) => n.content).join("\n\n");
        } else {
          initialNotes = jobRes.data.notes;
        }
      } catch {
        initialNotes = jobRes.data.notes;
      }
    }
    setNotesText(initialNotes);
    setSavedNotesText(initialNotes);
    setTermine((termineRes.data ?? []) as Termin[]);
    setDocuments((docsRes.data ?? []) as DocRow[]);
    setLoading(false);
  }

  // Autosave Notizen — geht ueber SECURITY-DEFINER-RPC `partner_update_notes`,
  // damit Partner Notizen auch in status='offen' aendern darf (die jobs-
  // UPDATE-RLS bleibt tight auf 'partner_anfrage' damit Partner nicht z.B.
  // status oder title selbst manipulieren).
  useEffect(() => {
    if (!canEditNotesAndDocs) return;
    if (notesText === savedNotesText) return;
    const handle = setTimeout(async () => {
      const { error } = await supabase.rpc("partner_update_notes", { p_job_id: id as string, p_notes: notesText });
      if (error) {
        TOAST.supabaseError(error, "Notizen konnten nicht gespeichert werden");
        return;
      }
      setSavedNotesText(notesText);
    }, 800);
    return () => clearTimeout(handle);
  }, [notesText, savedNotesText, id, supabase, canEditNotesAndDocs]);

  async function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const validated = validateFileList(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!validated || validated.length === 0) return;
    setUploadBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setUploadBusy(false); return; }
    let okCount = 0;
    for (const file of validated) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `partner-anfragen/${id}/${Date.now()}_${safeName}`;
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const json = await res.json();
        if (!json.success) { TOAST.uploadError(json.error); continue; }
        const { error: insertErr } = await supabase.from("documents").insert({
          name: file.name,
          storage_path: path,
          file_size: file.size,
          mime_type: file.type || null,
          job_id: id as string,
          uploaded_by: user.id,
        });
        if (insertErr) { TOAST.supabaseError(insertErr, "Dokument konnte nicht gespeichert werden"); continue; }
        okCount++;
      } catch (err) {
        TOAST.uploadError(err instanceof Error ? err.message : "Netzwerkfehler");
      }
    }
    setUploadBusy(false);
    if (okCount > 0) toast.success(`${okCount} Dokument${okCount > 1 ? "e" : ""} hochgeladen`);
    loadAll();
  }

  async function openDocPreview(doc: DocRow) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Datei nicht verfügbar");
      return;
    }
    setPreviewDoc({ url: data.signedUrl, title: doc.name });
  }

  async function downloadDoc(doc: DocRow) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Datei nicht verfügbar");
      return;
    }
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = doc.name;
    a.click();
  }

  async function submitAnfrage() {
    if (!canSubmit) return;
    const ok = await confirm({
      title: "Anfrage an EVENTLINE absenden?",
      message: "Nach dem Absenden kannst du den Termin nicht mehr selbst aendern — EVENTLINE pruft die Anfrage und meldet sich.",
      confirmLabel: "Absenden",
      variant: "red",
    });
    if (!ok) return;
    setSubmitting(true);
    const { error } = await supabase.rpc("partner_submit_anfrage", { p_job_id: id as string });
    setSubmitting(false);
    if (error) {
      TOAST.supabaseError(error, "Anfrage konnte nicht abgeschickt werden");
      return;
    }
    toast.success("Anfrage abgeschickt — EVENTLINE schaut sie an");
    loadAll();
  }

  async function addTermin(e: React.FormEvent) {
    e.preventDefault();
    if (!terminForm.title.trim() || !terminForm.date || !terminForm.time) {
      toast.error("Titel, Datum und Startzeit sind Pflicht");
      return;
    }
    setSavingTermin(true);
    const startISO = toLocalIsoString(terminForm.date, terminForm.time);
    const endISO = terminForm.end_time
      ? toLocalIsoString(terminForm.date, terminForm.end_time)
      : null;
    const { error } = await supabase.from("job_appointments").insert({
      job_id: id as string,
      title: terminForm.title.trim(),
      start_time: startISO,
      end_time: endISO,
      description: terminForm.description.trim() || null,
    });
    setSavingTermin(false);
    if (error) {
      TOAST.supabaseError(error, "Termin konnte nicht erstellt werden");
      return;
    }
    toast.success("Termin hinzugefügt");
    setTerminForm({ title: "", date: "", time: "", end_time: "", description: "" });
    setShowTerminForm(false);
    loadAll();
  }

  async function deleteTermin(termin: Termin) {
    const ok = await confirm({
      title: "Termin löschen?",
      message: `"${termin.title}" wird entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("job_appointments").delete().eq("id", termin.id);
    if (error) {
      TOAST.deleteError(error.message);
      return;
    }
    toast.success("Termin gelöscht");
    loadAll();
  }

  async function deleteAnfrage() {
    const ok = await confirm({
      title: "Anfrage löschen?",
      message: "Die Anfrage und alle zugehörigen Termine + Anhänge werden entfernt. Dies kann nicht rückgängig gemacht werden.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    // Storage-Files + DB-Rows zuerst — kein CASCADE annehmen.
    const { data: docs } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("job_id", id);
    if (docs && docs.length > 0) {
      await supabase.storage.from("documents").remove(docs.map((d) => d.storage_path));
    }
    await supabase.from("documents").delete().eq("job_id", id);
    await supabase.from("job_appointments").delete().eq("job_id", id);
    const { error, count } = await supabase
      .from("jobs")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) {
      TOAST.deleteError(error.message);
      return;
    }
    if (count === 0) {
      toast.error("Anfrage konnte nicht gelöscht werden — keine Berechtigung");
      return;
    }
    toast.success("Anfrage gelöscht");
    router.push("/partner/anfragen");
  }

  if (loading || !job) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-40 rounded bg-foreground/10 dark:bg-foreground/15 animate-pulse" />
        <div className="h-32 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => router.push("/partner/anfragen")}
          className="p-2 rounded-lg hover:bg-foreground/5 dark:hover:bg-foreground/10 transition-colors"
          aria-label="Zurück"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0">
          {job.job_number && (
            <span className="text-[10px] font-mono text-muted-foreground bg-foreground/[0.05] dark:bg-foreground/10 px-1.5 py-0.5 rounded">
              INT-{String(job.job_number).padStart(4, "0")}
            </span>
          )}
          <h1 className="text-2xl font-bold tracking-tight mt-1 truncate">{job.title}</h1>
        </div>
      </div>

      {/* Status-Banner */}
      {job.status === "partner_entwurf" && (
        <Card className="bg-foreground/[0.04] dark:bg-foreground/10 border-foreground/15 dark:border-foreground/20">
          <CardContent className="p-4 flex items-start gap-3">
            <Pencil className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm flex-1">
              <p className="font-semibold text-foreground">Entwurf — noch nicht abgeschickt</p>
              <p className="text-muted-foreground mt-0.5">
                {canSubmit
                  ? "Du kannst die Anfrage jetzt an EVENTLINE absenden."
                  : "Trag mindestens einen Termin ein, dann kannst du die Anfrage an EVENTLINE absenden."}
              </p>
            </div>
            {canSubmit && (
              <button
                type="button"
                onClick={submitAnfrage}
                disabled={submitting}
                className="kasten kasten-red shrink-0"
              >
                <Send className="h-3.5 w-3.5" />
                {submitting ? "Sendet…" : "Anfrage senden"}
              </button>
            )}
          </CardContent>
        </Card>
      )}
      {job.status === "partner_anfrage" && (
        <Card className="bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30">
          <CardContent className="p-4 flex items-start gap-3">
            <Clock className="h-5 w-5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-amber-800 dark:text-amber-200">Wartet auf EVENTLINE</p>
              <p className="text-amber-700 dark:text-amber-300 mt-0.5">
                EVENTLINE prüft die Anfrage und meldet sich. Du kannst Termine und Notizen jetzt noch anpassen.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {(job.status === "offen" || job.status === "abgeschlossen") && (
        <Card className="bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30">
          <CardContent className="p-4 flex items-start gap-3">
            <Check className="h-5 w-5 text-green-700 dark:text-green-300 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-green-800 dark:text-green-200">
                {job.status === "offen" ? "Bestätigt — EVENTLINE kümmert sich" : "Abgeschlossen"}
              </p>
              <p className="text-green-700 dark:text-green-300 mt-0.5">
                {job.status === "offen"
                  ? "Termin-Änderungen bitte direkt an EVENTLINE melden. Notizen und Dokumente kannst du weiter nachreichen."
                  : "Änderungen bitte direkt an EVENTLINE melden."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {job.status === "storniert" && (
        <Card className="bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30">
          <CardContent className="p-4 flex items-start gap-3">
            <XCircle className="h-5 w-5 text-red-700 dark:text-red-300 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-red-800 dark:text-red-200">Anfrage abgelehnt</p>
              {job.partner_response_message && (
                <p className="text-red-700 dark:text-red-300 mt-0.5">
                  Grund: {job.partner_response_message}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Anfrage-Details */}
      <Card className="bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(job.start_date || job.end_date) && (
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span>
                {job.start_date && new Date(job.start_date).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" })}
                {job.end_date && job.end_date !== job.start_date && ` – ${new Date(job.end_date).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" })}`}
              </span>
            </div>
          )}
          {job.description && (
            <div className="pt-2 border-t border-border">
              <p className="text-xs text-muted-foreground mb-1">Beschreibung</p>
              <p className="whitespace-pre-wrap">{job.description}</p>
            </div>
          )}
          {(job.contact_person || job.contact_phone || job.contact_email) && (
            <div className="pt-2 border-t border-border">
              <p className="text-xs text-muted-foreground mb-1">Veranstalter-Kontakt</p>
              {job.contact_person && <p>{job.contact_person}</p>}
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                {job.contact_phone && <span>{job.contact_phone}</span>}
                {job.contact_email && <span>{job.contact_email}</span>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Termine */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />Termine ({termine.length})
          </CardTitle>
          {!isReadOnly && (
            <button
              type="button"
              onClick={() => setShowTerminForm(!showTerminForm)}
              className="kasten kasten-blue"
            >
              <Plus className="h-3.5 w-3.5" />
              Termin
            </button>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {showTerminForm && !isReadOnly && (
            <form onSubmit={addTermin} className="p-3 rounded-lg bg-foreground/[0.03] border border-foreground/10 dark:bg-foreground/5 dark:border-foreground/15 space-y-3">
              <Input
                placeholder="Termin-Titel *"
                value={terminForm.title}
                onChange={(e) => setTerminForm({ ...terminForm, title: e.target.value })}
                required
              />
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] font-medium">Datum *</label>
                  <Input type="date" value={terminForm.date} onChange={(e) => setTerminForm({ ...terminForm, date: e.target.value })} className="mt-1" required />
                </div>
                <div>
                  <label className="text-[11px] font-medium">Von *</label>
                  <Input type="time" value={terminForm.time} onChange={(e) => setTerminForm({ ...terminForm, time: e.target.value })} className="mt-1" required />
                </div>
                <div>
                  <label className="text-[11px] font-medium">Bis</label>
                  <Input type="time" value={terminForm.end_time} onChange={(e) => setTerminForm({ ...terminForm, end_time: e.target.value })} className="mt-1" />
                </div>
              </div>
              <textarea
                placeholder="Beschreibung (optional)"
                value={terminForm.description}
                onChange={(e) => setTerminForm({ ...terminForm, description: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card resize-none"
                style={{ fieldSizing: "content" } as React.CSSProperties}
              />
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowTerminForm(false)} className="kasten kasten-muted flex-1">Abbrechen</button>
                <button type="submit" disabled={savingTermin} className="kasten kasten-blue flex-1">{savingTermin ? "Speichern…" : "Hinzufügen"}</button>
              </div>
            </form>
          )}
          {termine.length === 0 ? (
            isReadOnly ? (
              <div className="flex items-center gap-3 p-3 rounded-lg border border-dashed bg-muted/20">
                <AlertCircle className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Keine Termine.</p>
              </div>
            ) : (
              // Amber Aufmerksamkeits-Banner — gleiches Pattern wie im
              // Firmenportal /auftraege/[id]. Bei Entwurf-Status ohne Termin
              // soll der Partner sofort sehen dass hier was zu tun ist.
              <div className="flex items-center gap-3 p-3 rounded-xl border tinted-amber">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/20 shrink-0">
                  <Calendar className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">Kein Termin geplant</p>
                  <p className="text-xs opacity-80 mt-0.5">
                    {job.start_date ? (() => {
                      const days = Math.ceil((new Date(job.start_date).getTime() - Date.now()) / 86400000);
                      return days > 0 ? `Veranstaltung in ${days} Tag${days === 1 ? "" : "en"}` : days === 0 ? "Veranstaltung ist heute" : `Veranstaltung war vor ${Math.abs(days)} Tag${Math.abs(days) === 1 ? "" : "en"}`;
                    })() : "Kein Startdatum gesetzt"}
                    {isDraft
                      ? " · oben rechts „Termin“ anlegen — Anfrage kann erst danach abgeschickt werden"
                      : " · oben rechts „Termin“ anlegen"}
                  </p>
                </div>
              </div>
            )
          ) : (
            termine.map((t) => (
              <div key={t.id} className="flex items-start justify-between gap-3 p-3 rounded-lg bg-foreground/[0.02] dark:bg-foreground/[0.04] border border-foreground/10 dark:border-foreground/15">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{t.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(t.start_time).toLocaleString("de-CH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    {t.end_time && ` – ${new Date(t.end_time).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}`}
                  </p>
                  {t.description && <p className="text-xs mt-1 whitespace-pre-wrap">{t.description}</p>}
                </div>
                {!isReadOnly && (
                  <button
                    type="button"
                    onClick={() => deleteTermin(t)}
                    className="kasten kasten-red shrink-0"
                    aria-label="Termin löschen"
                    data-tooltip="Löschen"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Notizen */}
      <Card className="bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <StickyNote className="h-4 w-4" />Notizen
          </CardTitle>
        </CardHeader>
        <CardContent>
          <textarea
            value={notesText}
            onChange={(e) => setNotesText(e.target.value)}
            placeholder={canEditNotesAndDocs ? "Was EVENTLINE noch wissen sollte… (wird automatisch gespeichert)" : "Keine Notizen."}
            disabled={!canEditNotesAndDocs}
            rows={4}
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:bg-muted/30 disabled:cursor-not-allowed"
          />
        </CardContent>
      </Card>

      {/* Dokumente */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <FileText className="h-4 w-4" />Dokumente ({documents.length})
          </CardTitle>
          {canEditNotesAndDocs && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadBusy}
                className="kasten kasten-blue"
              >
                <Upload className="h-3.5 w-3.5" />
                {uploadBusy ? "Lädt hoch…" : "Hochladen"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                className="hidden"
                onChange={onFilesPicked}
              />
            </>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {documents.length === 0 ? (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-dashed bg-muted/20">
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {canEditNotesAndDocs ? "Noch keine Dokumente. Klick auf „Hochladen“ um eines anzuhängen." : "Keine Dokumente."}
              </p>
            </div>
          ) : (
            documents.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-foreground/[0.02] dark:bg-foreground/[0.04] border border-foreground/10 dark:border-foreground/15">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{doc.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {doc.file_size ? (doc.file_size / 1024).toFixed(0) + " KB · " : ""}
                      {new Date(doc.created_at).toLocaleDateString("de-CH")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openDocPreview(doc)}
                    className="kasten kasten-blue"
                    data-tooltip="Vorschau"
                    aria-label="Vorschau"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadDoc(doc)}
                    className="kasten kasten-muted"
                    data-tooltip="Herunterladen"
                    aria-label="Herunterladen"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Anfrage loeschen — nur solange noch nicht bearbeitet */}
      {!isReadOnly && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={deleteAnfrage}
            className="kasten kasten-red"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Anfrage zurückziehen
          </button>
        </div>
      )}

      {previewDoc && (
        <PdfPopup
          url={previewDoc.url}
          title={previewDoc.title}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {ConfirmModalElement}
    </div>
  );
}
