"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Calendar, Clock, Plus, Trash2, StickyNote, Check, XCircle, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { useConfirm } from "@/components/ui/use-confirm";
import { toLocalIsoString } from "@/lib/format";

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

export default function PartnerAnfrageDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();

  const [job, setJob] = useState<AnfrageDetail | null>(null);
  const [termine, setTermine] = useState<Termin[]>([]);
  const [loading, setLoading] = useState(true);
  const [notesText, setNotesText] = useState("");
  const [savedNotesText, setSavedNotesText] = useState("");
  const [showTerminForm, setShowTerminForm] = useState(false);
  const [terminForm, setTerminForm] = useState({ title: "", date: "", time: "", end_time: "", description: "" });
  const [savingTermin, setSavingTermin] = useState(false);

  // Read-Only sobald die Anfrage angenommen oder abgelehnt ist
  const isReadOnly = job ? job.status !== "partner_anfrage" : true;

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadAll() {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, job_number, title, description, start_date, end_date, status, notes, partner_response_message, accepted_at, rejected_at, contact_person, contact_phone, contact_email")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) {
      toast.error("Anfrage nicht gefunden");
      router.push("/partner/anfragen");
      return;
    }
    setJob(data as AnfrageDetail);
    setNotesText(data.notes ?? "");
    setSavedNotesText(data.notes ?? "");
    const { data: tdata } = await supabase
      .from("job_appointments")
      .select("id, title, start_time, end_time, description")
      .eq("job_id", id)
      .order("start_time");
    setTermine((tdata ?? []) as Termin[]);
    setLoading(false);
  }

  // Autosave Notizen
  useEffect(() => {
    if (isReadOnly) return;
    if (notesText === savedNotesText) return;
    const handle = setTimeout(async () => {
      await supabase.from("jobs").update({ notes: notesText || null }).eq("id", id);
      setSavedNotesText(notesText);
    }, 800);
    return () => clearTimeout(handle);
  }, [notesText, savedNotesText, id, supabase, isReadOnly]);

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
      {job.status === "partner_anfrage" && (
        <Card className="bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30">
          <CardContent className="p-4 flex items-start gap-3">
            <Clock className="h-5 w-5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-amber-800 dark:text-amber-200">Wartet auf Eventline</p>
              <p className="text-amber-700 dark:text-amber-300 mt-0.5">
                Eventline prüft die Anfrage und meldet sich. Du kannst Termine und Notizen jetzt noch anpassen.
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
                {job.status === "offen" ? "Bestätigt — Eventline kümmert sich" : "Abgeschlossen"}
              </p>
              <p className="text-green-700 dark:text-green-300 mt-0.5">
                Änderungen bitte direkt an Eventline melden.
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
            <div className="flex items-center gap-3 p-3 rounded-lg border border-dashed bg-muted/20">
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {isReadOnly ? "Keine Termine." : 'Noch keine Termine. Klick auf „Termin" um anzufangen.'}
              </p>
            </div>
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
            placeholder={isReadOnly ? "Keine Notizen." : "Was Eventline noch wissen sollte… (wird automatisch gespeichert)"}
            disabled={isReadOnly}
            rows={4}
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:bg-muted/30 disabled:cursor-not-allowed"
          />
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

      {ConfirmModalElement}
    </div>
  );
}
