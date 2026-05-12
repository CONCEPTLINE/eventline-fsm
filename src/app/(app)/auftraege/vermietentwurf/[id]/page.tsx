"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { validateFileList } from "@/lib/file-upload";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Job } from "@/types";
import { REQUEST_STEPS, REQUEST_MAIL_STEPS } from "@/lib/constants";
import {
  MapPin, Users, Calendar, ArrowRight, Check, X, XCircle,
  StickyNote, FileText, Send, Download, Trash2, Pencil, Upload, Eye,
} from "lucide-react";
import { PdfPopup } from "@/components/pdf-popup";
import { BackButton } from "@/components/ui/back-button";
import Link from "next/link";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { JobNumber } from "@/components/job-number";
import { RequestStepTracker } from "@/components/request-step-tracker";
import { SendStepModal } from "@/components/send-step-modal";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { usePermissions } from "@/lib/use-permissions";

export default function AnfrageDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const supabase = createClient();

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);

  // Dokumente am Vermietentwurf — landen automatisch hier sobald via
  // SendStepModal hochgeladen (job_id = id, RLS via authentifizierten User).
  const [documents, setDocuments] = useState<Array<{
    id: string;
    name: string;
    storage_path: string;
    file_size: number | null;
    created_at: string;
  }>>([]);

  // Notizen — autosave
  const [notesText, setNotesText] = useState("");
  const [savedText, setSavedText] = useState("");

  // Storno-Flow: 2-Phasen-Modal wie beim Auftrag
  const [cancelPhase, setCancelPhase] = useState<"closed" | "confirm" | "reason">("closed");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelSaving, setCancelSaving] = useState(false);

  // Convert-Modal
  const [convertSaving, setConvertSaving] = useState(false);
  const { can } = usePermissions();

  // Mail-Modal: gemeinsame Komponente, nur Open-Flag hier.
  const [sendOpen, setSendOpen] = useState(false);

  // Direkt-Upload aus der Dokumentenliste — getrennt vom Mail-Schritt-
  // Upload. Pfad startet mit "vermietentwurf-direct/" damit man Mail-
  // Anhaenge (vermietentwurf/{id}/s{step}/) klar unterscheiden kann.
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Floating Vorschau (Eye-Button) — non-modal.
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Confirm-Dialoge fuer Manuell-Bestaetigen (Warte-Schritte 2/4) und Zurueck.
  const [showManualConfirm, setShowManualConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);

  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => {
    loadJob();
    loadDocuments();
    // SendStepModal feuert dieses Event nach jedem erfolgreichen Upload —
    // dann frisch laden, damit das neue Dokument hier in der Liste auftaucht.
    const handler = () => loadDocuments();
    window.addEventListener("documents:invalidate", handler);

    // Realtime via globalen Layout-Channel — wenn der Kunde via Mail-Confirm
    // den Job aktualisiert, fliesst das Event als "realtime:jobs" auch hier
    // rein und wir laden neu. Vorher lief hier ein eigener WebSocket pro
    // Detail-Page, was sich bei vielen offenen Tabs aufaddiert hat.
    const jobsHandler = () => { loadJob(); };
    window.addEventListener("realtime:jobs", jobsHandler);

    return () => {
      window.removeEventListener("documents:invalidate", handler);
      window.removeEventListener("realtime:jobs", jobsHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadDocuments() {
    const { data } = await supabase
      .from("documents")
      .select("id, name, storage_path, file_size, created_at")
      .eq("job_id", id)
      .order("created_at", { ascending: false });
    setDocuments((data as typeof documents) ?? []);
  }

  async function previewDocFn(storagePath: string, name: string) {
    const { data } = await supabase.storage.from("documents").createSignedUrl(storagePath, 3600);
    if (data?.signedUrl) {
      setPreviewDoc({ url: data.signedUrl, title: name });
    }
  }

  async function downloadDoc(storagePath: string, name: string) {
    const { data } = await supabase.storage.from("documents").createSignedUrl(storagePath, 3600);
    if (data?.signedUrl) {
      const a = document.createElement("a");
      a.href = data.signedUrl;
      a.download = name;
      a.click();
    }
  }

  async function deleteDoc(docId: string, storagePath: string, name: string) {
    const ok = await confirm({
      title: "Dokument löschen?",
      message: `"${name}" wird unwiderruflich entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    // Erst aus Storage, dann aus documents-Tabelle. Wenn Storage failt, ueberspringen
    // wir die DB-Loeschung nicht — die Verwaltung des Files muss schliesslich raus.
    await supabase.storage.from("documents").remove([storagePath]);
    const result = await deleteRow("documents", docId);
    if (!result.ok) {
      TOAST.deleteError(result.error);
      return;
    }
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
    toast.success("Dokument gelöscht");
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const validated = validateFileList(files);
    if (!validated) return;
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setUploading(false); return; }
    let okCount = 0;
    for (const file of validated) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `vermietentwurf-direct/${id}/${Date.now()}_${safeName}`;
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const json = await res.json();
        if (!json.success) {
          TOAST.uploadError(json.error);
          continue;
        }
        const { error: insertErr } = await supabase.from("documents").insert({
          name: file.name,
          storage_path: path,
          file_size: file.size,
          mime_type: file.type || null,
          job_id: id as string,
          uploaded_by: user.id,
        });
        if (insertErr) {
          TOAST.supabaseError(insertErr, "Dokument konnte nicht gespeichert werden");
          continue;
        }
        okCount++;
      } catch (err) {
        TOAST.uploadError(err instanceof Error ? err.message : "Netzwerkfehler");
      }
    }
    if (okCount > 0) {
      toast.success(okCount === 1 ? "Datei hochgeladen" : `${okCount} Dateien hochgeladen`);
      await loadDocuments();
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function loadJob() {
    const { data, error } = await supabase
      .from("jobs")
      // Adressen bewusst weggelassen — in den Vermietentwurf-Details werden
      // nur Namen angezeigt, Adressen leaken sonst durch unbenutzte Joins.
      .select("*, customer:customers(name, email), location:locations(name)")
      .eq("id", id)
      .single();
    if (error || !data) {
      toast.error("Vermietentwurf nicht gefunden");
      router.push("/auftraege");
      return;
    }
    if (data.status !== "anfrage" && data.status !== "storniert") {
      // Wurde bereits konvertiert -> redirect zur Auftrags-Detail
      router.replace(`/auftraege/${data.id}`);
      return;
    }
    setJob(data as unknown as Job);
    setNotesText(data.notes ?? "");
    setSavedText(data.notes ?? "");
    setLoading(false);
  }

  // Notizen autosave debounced
  useEffect(() => {
    if (notesText === savedText) return;
    const handle = setTimeout(async () => {
      await supabase.from("jobs").update({ notes: notesText || null }).eq("id", id);
      setSavedText(notesText);
    }, 800);
    return () => clearTimeout(handle);
  }, [notesText, savedText, id, supabase]);

  async function handleNextStep() {
    if (!job?.request_step) return;
    if (REQUEST_MAIL_STEPS.has(job.request_step)) {
      setSendOpen(true);
      return;
    }
    // Warte-Schritte (2, 4): manuelles Bestaetigen — der Kunde haette eigentlich aus
    // der Mail bestaetigen sollen. Confirm-Dialog zeigen, damit Klick nicht versehentlich
    // einen Schritt vorruckelt.
    setShowManualConfirm(true);
  }

  // Wirklich speichern. Wird sowohl von Warte-Schritten als auch von der Confirm-Phase
  // des Mail-Modals aufgerufen.
  async function advanceStepRaw() {
    if (!job?.request_step) return;
    const nextStep = job.request_step + 1;
    if (nextStep > 4) {
      // Schritt 4 (Angebot bestaetigt) erledigt -> direkt umwandeln. Kein
      // Entwurfs-Zwischenschritt, kein Confirm-Modal: die Akquise-Phase war
      // ja schon der Vermietentwurf, da gibt's nichts mehr zu pruefen.
      await convertToAuftrag();
      return;
    }
    const { error } = await supabase
      .from("jobs")
      .update({ request_step: nextStep })
      .eq("id", id);
    if (error) {
      TOAST.supabaseError(error);
      return;
    }
    toast.success(REQUEST_STEPS[nextStep - 1].label);
    window.dispatchEvent(new Event("jobs:invalidate"));
    loadJob();
  }

  async function previousStep() {
    if (!job?.request_step || job.request_step <= 1) return;
    const prevStep = job.request_step - 1;
    const { error } = await supabase
      .from("jobs")
      .update({ request_step: prevStep })
      .eq("id", id);
    if (error) {
      TOAST.supabaseError(error);
      return;
    }
    toast.success(`Zurück zu Schritt ${prevStep}`);
    window.dispatchEvent(new Event("jobs:invalidate"));
    loadJob();
  }

  async function confirmCancel() {
    if (!cancelReason.trim()) {
      toast.error("Bitte einen Grund angeben");
      return;
    }
    setCancelSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("jobs")
      .update({
        status: "storniert",
        request_step: null,
        cancelled_by: user?.id ?? null,
        cancelled_at: new Date().toISOString(),
        cancellation_reason: cancelReason.trim(),
        cancelled_as_anfrage: true,
      })
      .eq("id", id);
    setCancelSaving(false);
    if (error) {
      TOAST.supabaseError(error);
      return;
    }
    setCancelPhase("closed");
    setCancelReason("");
    toast.success("Vermietentwurf storniert");
    window.dispatchEvent(new Event("jobs:invalidate"));
    router.push("/auftraege");
  }

  async function convertToAuftrag() {
    setConvertSaving(true);
    // status='offen' direkt — kein Entwurf-Zwischenschritt, weil die
    // Akquise/Pruefung schon im Vermietentwurf-Prozess passiert ist.
    // was_anfrage bleibt true → hellblauer Vermietung-Tag haengt am Auftrag.
    const { error } = await supabase
      .from("jobs")
      .update({
        status: "offen",
        request_step: null,
      })
      .eq("id", id);
    setConvertSaving(false);
    if (error) {
      TOAST.supabaseError(error);
      return;
    }
    toast.success("Vermietentwurf in Auftrag umgewandelt");
    window.dispatchEvent(new Event("jobs:invalidate"));
    router.push(`/auftraege/${id}`);
  }

  if (loading || !job) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="h-8 w-40 rounded bg-muted animate-pulse" />
        <div className="h-32 rounded-xl bg-muted animate-pulse" />
      </div>
    );
  }

  const customer = (job.customer as unknown as { name: string }) || null;
  const location = (job.location as unknown as { name: string }) || null;
  // Step zwischen 1 und REQUEST_STEPS.length clampen — defensiv gegen
  // Alt-Daten mit request_step ueber dem aktuellen Pipeline-Maximum.
  const currentStep = Math.min(Math.max(job.request_step ?? 1, 1), REQUEST_STEPS.length);
  const stepInfo = REQUEST_STEPS[currentStep - 1];
  const isLastStep = currentStep === REQUEST_STEPS.length;
  const isCancelled = job.status === "storniert";

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-3">
        <BackButton fallbackHref="/auftraege" />
        <div className="flex-1 min-w-0">
          <div className="space-y-1.5">
            <JobNumber number={job.job_number} size="md" />
            <h1 className="text-2xl font-bold tracking-tight">{job.title}</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {isCancelled ? "Vermietentwurf · storniert" : "Vermietentwurf · noch nicht freigegeben"}
          </p>
        </div>
        {!isCancelled && (
          <Link
            href={`/auftraege/vermietentwurf/${id}/bearbeiten`}
            className="kasten kasten-purple shrink-0"
          >
            <Pencil className="h-3.5 w-3.5" />
            Bearbeiten
          </Link>
        )}
      </div>

      {/* Step-Tracker — nur wenn nicht abgelehnt */}
      {!isCancelled && (
        <Card className="bg-card">
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Aktueller Schritt</p>
                <p className="text-base font-semibold mt-0.5">{currentStep}. {stepInfo.label}</p>
              </div>
              <div className="flex items-center gap-2">
                {/* Step-Aktionen nur fuer User mit auftraege:edit — alle
                    Schritte mutieren den Vermietentwurf. Vorher waren die
                    Buttons fuer alle sichtbar, RLS hat dann still abgelehnt. */}
                {can("auftraege:edit") && currentStep > 1 && (
                  <button
                    type="button"
                    onClick={() => setShowBackConfirm(true)}
                    className="kasten kasten-muted"
                  >
                    Zurück
                  </button>
                )}
                {can("auftraege:edit") && (
                <button
                  type="button"
                  onClick={handleNextStep}
                  className="kasten kasten-purple"
                >
                  {REQUEST_MAIL_STEPS.has(currentStep) ? (
                    <>
                      <Send className="h-3.5 w-3.5" />
                      {stepInfo.label}
                    </>
                  ) : currentStep === 2 ? (
                    <>
                      Manuell Konditionen bestätigen
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  ) : currentStep === 4 ? (
                    <>
                      Manuell Angebot bestätigen
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  ) : (
                    <>
                      Nächster Schritt
                      <ArrowRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </button>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <RequestStepTracker currentStep={currentStep} size="lg" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Storno-Info wenn storniert */}
      {isCancelled && job.cancellation_reason && (
        <Card className="bg-card border-destructive/30">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <XCircle className="h-4 w-4" />
              Storniert
            </div>
            {job.cancelled_at && (
              <div className="text-sm text-muted-foreground">
                am <span className="font-medium text-foreground">{new Date(job.cancelled_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}</span>
              </div>
            )}
            <div className="pt-2 border-t border-foreground/[0.06]">
              <p className="text-xs text-muted-foreground mb-1">Grund</p>
              <p className="text-sm whitespace-pre-wrap">{job.cancellation_reason}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Anfrage-Daten */}
      <Card className="bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <FileText className="h-4 w-4" />Vermietentwurf-Details
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5 pt-0 space-y-3">
          {customer && (
            <div className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Kunde:</span>
              <span>{customer.name}</span>
            </div>
          )}
          {location && (
            <div className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Location:</span>
              <span>{location.name}</span>
            </div>
          )}
          {(job.start_date || job.end_date) && (
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Event-Datum:</span>
              <span>
                {job.start_date && new Date(job.start_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
                {job.end_date && job.end_date !== job.start_date && ` – ${new Date(job.end_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}`}
              </span>
            </div>
          )}
          {(job.event_type || job.guest_count) && (
            <div className="flex items-center gap-4 text-sm flex-wrap">
              {job.event_type && (
                <div className="flex items-center gap-2">
                  <span className="font-medium">Veranstaltung:</span>
                  <span>{job.event_type}</span>
                </div>
              )}
              {job.guest_count && (
                <div className="flex items-center gap-2">
                  <span className="font-medium">Personen:</span>
                  <span>{job.guest_count}</span>
                </div>
              )}
            </div>
          )}
          {job.description && (
            <div className="pt-2 border-t border-foreground/[0.06]">
              <p className="text-xs text-muted-foreground mb-1">Beschreibung</p>
              <p className="text-sm whitespace-pre-wrap">{job.description}</p>
            </div>
          )}
          {job.extended_services && (
            <div className="pt-2 border-t border-foreground/[0.06]">
              <p className="text-xs text-muted-foreground mb-1">Zusatzleistungen</p>
              <p className="text-sm whitespace-pre-wrap">{job.extended_services}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dokumente — Mail-Anhaenge landen hier automatisch, zusaetzlich
          kann direkt hochgeladen werden (z.B. interne Notizen, vom Kunden
          per Mail zurueckgeschickte Vertraege). */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <FileText className="h-4 w-4" />Dokumente ({documents.length})
          </CardTitle>
          {!isCancelled && can("auftraege:edit") && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                className="hidden"
                onChange={handleFileUpload}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="kasten kasten-muted"
              >
                <Upload className="h-3.5 w-3.5" />
                {uploading ? "Lädt…" : "Dokumente hinzufügen"}
              </button>
            </>
          )}
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              Noch keine Dokumente.
            </p>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between p-3 rounded-xl bg-foreground/[0.02] border">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-5 w-5 text-red-500 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{doc.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {doc.file_size ? (doc.file_size / 1024).toFixed(0) + " KB" : ""}
                        {doc.file_size ? " · " : ""}
                        {new Date(doc.created_at).toLocaleDateString("de-CH")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => previewDocFn(doc.storage_path, doc.name)}
                      className="kasten kasten-blue"
                      data-tooltip="Vorschau"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadDoc(doc.storage_path, doc.name)}
                      className="kasten kasten-muted"
                      data-tooltip="Herunterladen"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteDoc(doc.id, doc.storage_path, doc.name)}
                      className="kasten kasten-red"
                      data-tooltip="Löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notizen — autosave */}
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
            placeholder="Reinschreiben — wird automatisch gespeichert."
            rows={4}
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
          />
        </CardContent>
      </Card>

      {/* Stornieren — nur wenn aktiv. Gleiche Optik + 2-Phasen-Flow wie beim Auftrag. */}
      {!isCancelled && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setCancelPhase("confirm")}
            className="kasten kasten-red"
          >
            <XCircle className="h-3.5 w-3.5" />
            Stornieren
          </button>
        </div>
      )}

      {/* Manuell-bestaetigen-Confirm (Schritt 2/4 — Kunde haette aus Mail bestaetigen sollen) */}
      <Modal
        open={showManualConfirm}
        onClose={() => setShowManualConfirm(false)}
        title={currentStep === 2 ? "Konditionen manuell bestätigen?" : "Angebot manuell bestätigen?"}
      >
        <p className="text-sm text-muted-foreground">
          Normalerweise bestätigt der Kunde direkt aus der Mail. Bist du sicher, dass{" "}
          {currentStep === 2 ? "die Konditionen" : "das Angebot"} bereits bestätigt wurden (z.B. telefonisch)?
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowManualConfirm(false)} className="kasten kasten-muted flex-1">
            Abbrechen
          </button>
          <button
            type="button"
            onClick={async () => {
              setShowManualConfirm(false);
              await advanceStepRaw();
            }}
            className="kasten kasten-purple flex-1"
          >
            Ja, bestätigen
          </button>
        </div>
      </Modal>

      {/* Zurueck-Schritt-Confirm */}
      <Modal
        open={showBackConfirm}
        onClose={() => setShowBackConfirm(false)}
        title="Schritt zurücksetzen?"
      >
        <p className="text-sm text-muted-foreground">
          Du gehst zurück zu Schritt {Math.max(1, currentStep - 1)} ({REQUEST_STEPS[Math.max(0, currentStep - 2)].label}). Schon gesendete Mails bleiben beim Kunden — der Klick im Mail würde diesen Schritt wieder vorruckeln.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setShowBackConfirm(false)} className="kasten kasten-muted flex-1">
            Abbrechen
          </button>
          <button
            type="button"
            onClick={async () => {
              setShowBackConfirm(false);
              await previousStep();
            }}
            className="kasten kasten-purple flex-1"
          >
            Zurücksetzen
          </button>
        </div>
      </Modal>

      {/* Storno-Flow: Phase 'confirm' -> 'reason' (identisch zum Auftrag) */}
      <Modal
        open={cancelPhase !== "closed"}
        onClose={() => { setCancelPhase("closed"); setCancelReason(""); }}
        title={cancelPhase === "confirm" ? "Vermietentwurf stornieren?" : "Grund angeben"}
        closable={!cancelSaving}
      >
        <p className="text-sm text-muted-foreground">
          {job.job_number ? `INT-${job.job_number} — ` : ""}
          <span className="font-medium text-foreground">&quot;{job.title}&quot;</span>
        </p>
        {cancelPhase === "confirm" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Der Vermietentwurf wird als storniert archiviert. Du kannst ihn nachher noch einsehen.
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setCancelPhase("closed")} className="kasten kasten-muted flex-1">
                Abbrechen
              </button>
              <button type="button" onClick={() => setCancelPhase("reason")} className="kasten kasten-red flex-1">
                Stornieren
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Bitte gib einen Grund an, warum dieser Vermietentwurf storniert wird.
            </p>
            <textarea
              placeholder="z.B. Termin nicht verfügbar, Kunde hat abgesagt…"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={3}
              autoFocus
              className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCancelPhase("confirm")}
                disabled={cancelSaving}
                className="kasten kasten-muted flex-1"
              >
                Zurück
              </button>
              <button
                type="button"
                onClick={confirmCancel}
                disabled={cancelSaving || !cancelReason.trim()}
                className="kasten kasten-red flex-1"
              >
                {cancelSaving ? "Storniere…" : "Bestätigen"}
              </button>
            </div>
          </>
        )}
      </Modal>

      <SendStepModal
        open={sendOpen}
        jobId={String(id)}
        step={(job.request_step ?? 1) as 1 | 2 | 3 | 4}
        customerEmail={(job.customer as unknown as { email?: string | null } | undefined)?.email ?? ""}
        customerName={customer?.name ?? null}
        locationName={location?.name ?? null}
        eventDate={job.start_date}
        eventEndDate={job.end_date}
        onClose={() => setSendOpen(false)}
        onAdvance={advanceStepRaw}
      />

      {ConfirmModalElement}

      {previewDoc && (
        <PdfPopup
          url={previewDoc.url}
          title={previewDoc.title}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </div>
  );
}
