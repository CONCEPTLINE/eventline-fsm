"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { validateFileList } from "@/lib/file-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JOB_STATUS } from "@/lib/constants";
import type { JobAssignment, JobAppointment, Profile, Document as DocType, JobStatus, JobDetailWithRelations, ServiceReport } from "@/types";

// Rapport mit eingebettetem Creator — wie Supabase-Join es liefert.
type ReportWithCreator = ServiceReport & {
  creator: { full_name: string } | null;
};
import {
  MapPin, User, Calendar, Clock, FileText, Plus, Upload, Camera,
  Check, CheckCircle, XCircle, Trash2, UserCheck, Download, Send, X, StickyNote, Pencil, AlertCircle, Inbox, ExternalLink, Eye,
  Phone, Mail,
} from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import Link from "next/link";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { JobNumber } from "@/components/job-number";
import { PdfPopup } from "@/components/pdf-popup";
import { Modal } from "@/components/ui/modal";
import { BexioButton } from "@/components/bexio-button";
import { useConfirm } from "@/components/ui/use-confirm";
import { AppointmentsSection } from "@/components/auftrag/appointments-section";
import { RapportFormModal } from "@/components/auftrag/rapport-form-modal";
import { HoursAuditCard } from "@/components/auftrag/hours-audit-card";
import { JobStempelButton } from "@/components/stempel/job-stempel-button";
import { PartnerFormAnswersCard } from "@/components/auftrag/partner-form-answers-card";
import { Loading } from "@/components/ui/spinner";
import { usePermissions } from "@/lib/use-permissions";

export default function AuftragDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const { can } = usePermissions();

  const [job, setJob] = useState<JobDetailWithRelations | null>(null);
  const [assignments, setAssignments] = useState<JobAssignment[]>([]);
  const [appointments, setAppointments] = useState<JobAppointment[]>([]);
  const [documents, setDocuments] = useState<DocType[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reports, setReports] = useState<ReportWithCreator[]>([]);
  // Floating PDF/Image-Vorschau — non-modal, App bleibt bedienbar.
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Stundenkontrolle (admin-only): pro Mitarbeiter Stempel- vs Rapport-
  // Stunden und die Differenz. Geladen via SECURITY-DEFINER-RPC, das
  // intern den is_admin()-Check macht. Bei Non-Admin bleibt audit leer.
  const [isAdmin, setIsAdmin] = useState(false);
  const [audit, setAudit] = useState<Array<{
    user_id: string;
    user_name: string;
    stempel_minutes: number;
    rapport_minutes: number;
    diff_minutes: number;
  }>>([]);

  const [uploading, setUploading] = useState(false);
  const [showRapportModal, setShowRapportModal] = useState(false);
  // Auftrag stammt aus einer Instandhaltung (FK maintenance_tasks.job_id).
  // Steuert den Rapport-Flow: keine Kunden-Unterschrift bei technischen Arbeiten.
  const [isMaintenanceJob, setIsMaintenanceJob] = useState(false);

  // Notizen — eine Freitext-Notiz pro Auftrag, autosave on debounce
  const [notesText, setNotesText] = useState("");
  const [savedText, setSavedText] = useState("");

  // Stornieren-Flow: Modal mit zwei Phasen (confirm -> reason)
  const [cancelPhase, setCancelPhase] = useState<"closed" | "confirm" | "reason">("closed");
  // Partner-Anfrage: separater Decision-Flow. Annahme = via useConfirm,
  // Ablehnung = eigenes Reason-Modal weil Begruendung Pflicht ist.
  const [partnerRejectOpen, setPartnerRejectOpen] = useState(false);
  const [partnerRejectReason, setPartnerRejectReason] = useState("");
  const [partnerDecisionBusy, setPartnerDecisionBusy] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelSaving, setCancelSaving] = useState(false);

  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => { loadAll(); }, [id]);

  // Auto-open-Termin-Form: ?termin=neu in der URL ist der Trigger.
  // AppointmentsSection liest defaultOpen beim Mount; wir entfernen den
  // Param nach Mount damit Refresh das Formular nicht wieder oeffnet.
  const autoOpenAppt = searchParams.get("termin") === "neu";
  useEffect(() => {
    if (autoOpenAppt) {
      router.replace(`/auftraege/${id}`, { scroll: false });
      setTimeout(() => {
        document.getElementById("termin-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
  }, [autoOpenAppt, id, router]);

  async function loadAll() {
    const [jobRes, assignRes, apptRes, docRes, profRes, repRes, maintRes] = await Promise.all([
      supabase.from("jobs").select("*, customer:customers(id, name, address_street, address_zip, address_city, bexio_contact_id), location:locations(id, name, address_street, address_zip, address_city, customer:customers(id, name)), room:rooms(id, name, address_street, address_zip, address_city), project_lead:profiles!project_lead_id(full_name), cancelled_by_profile:profiles!cancelled_by(full_name)").eq("id", id).single(),
      supabase.from("job_assignments").select("*, profile:profiles(full_name, role)").eq("job_id", id),
      supabase.from("job_appointments").select("*, assignee:profiles!assigned_to(full_name)").eq("job_id", id).order("start_time"),
      supabase.from("documents").select("*").eq("job_id", id).order("created_at", { ascending: false }),
      // Nur die Felder die das Form/Dropdown wirklich braucht — Profil-Listen
      // werden bei 100+ Mitarbeitern sonst pro Auftrags-Detail-View 100+ Rows
      // schwer.
      // Partner-User raus — die werden nicht Eventline-internen Auftraegen zugewiesen.
      supabase.from("profiles").select("id, full_name, role, is_active").eq("is_active", true).neq("role", "partner").order("full_name"),
      supabase.from("service_reports").select("*, creator:profiles!created_by(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
      supabase.from("maintenance_tasks").select("id", { head: true, count: "exact" }).eq("job_id", id),
    ]);
    setIsMaintenanceJob((maintRes.count ?? 0) > 0);
    if (jobRes.data) {
      setJob(jobRes.data as unknown as JobDetailWithRelations);
      // Notizen: alte JSON-Liste -> joined als Text. Plain-Text bleibt as-is.
      let initial = "";
      if (jobRes.data.notes) {
        try {
          const parsed = JSON.parse(jobRes.data.notes);
          if (Array.isArray(parsed._notes)) {
            initial = parsed._notes.map((n: { content: string }) => n.content).join("\n\n");
          } else {
            initial = jobRes.data.notes;
          }
        } catch {
          initial = jobRes.data.notes;
        }
      }
      setNotesText(initial);
      setSavedText(initial);
    }
    if (assignRes.data) setAssignments(assignRes.data as unknown as JobAssignment[]);
    if (apptRes.data) setAppointments(apptRes.data as unknown as JobAppointment[]);
    if (docRes.data) setDocuments(docRes.data as DocType[]);
    if (profRes.data) setProfiles(profRes.data as Profile[]);
    if (repRes.data) setReports(repRes.data as unknown as ReportWithCreator[]);

    // Admin-Status pruefen — bestimmt ob die Stundenkontrolle-Card angezeigt
    // wird und ob der RPC-Call sinnvoll ist (Non-Admin bekaeme 403).
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profileRow } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      const admin = profileRow?.role === "admin";
      setIsAdmin(admin);
      if (admin) {
        const { data: auditRows } = await supabase.rpc("get_job_hours_audit", {
          p_job_id: id,
        });
        setAudit((auditRows as typeof audit) ?? []);
      }
    }
  }

  // Notizen autosave: 800ms nach letzter Aenderung in DB schreiben.
  // Speichert als plain text — keine JSON-Liste mehr. Loader handhabt beide Formate.
  useEffect(() => {
    if (notesText === savedText) return;
    const handle = setTimeout(async () => {
      await supabase.from("jobs").update({ notes: notesText || null }).eq("id", id);
      setSavedText(notesText);
    }, 800);
    return () => clearTimeout(handle);
  }, [notesText, savedText, id, supabase]);

  async function updateStatus(newStatus: JobStatus) {
    if (newStatus === "abgeschlossen") {
      // Modal oeffnet immer — auch vor Erreichen des End-Datums (User
      // kann Rapport-Draft schon vorab pflegen). Final-Submit erst wenn
      // canFinish && Termine-Check ok. Termine-Warnung erst beim
      // tatsaechlichen Auftrag-Schliessen, nicht beim Modal-Open —
      // sonst nervt's bei jedem Draft-Edit.
      setShowRapportModal(true);
      return;
    }
    // Freigeben (entwurf -> offen) blocken wenn Datum fehlt — sonst
    // landen offene Auftraege ohne Datum in der Liste / im Kalender und
    // tauchen in den Counts/Stats nirgends auf.
    if (newStatus === "offen" && job && (!job.start_date || !job.end_date)) {
      toast.error("Bitte erst Start- und Enddatum im Bearbeiten-Modus setzen, dann freigeben");
      return;
    }

    await supabase.from("jobs").update({ status: newStatus }).eq("id", id);
    toast.success(`Status auf "${JOB_STATUS[newStatus].label}" geändert`);
    loadAll();
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
        cancelled_by: user?.id ?? null,
        cancelled_at: new Date().toISOString(),
        cancellation_reason: cancelReason.trim(),
      })
      .eq("id", id);
    setCancelSaving(false);
    if (error) {
      TOAST.supabaseError(error);
      return;
    }
    setCancelPhase("closed");
    setCancelReason("");
    toast.success("Auftrag storniert");
    loadAll();
  }

  // Mail-Anhaenge aus dem Vermietentwurf duerfen nicht geloescht werden — sie
  // dokumentieren, was an den Kunden ging (Konditionen/Angebot, das er
  // bestaetigt hat). Direkt-Uploads aus diesem Auftrag (storage_path beginnt
  // mit 'jobs/') sind frei loeschbar.
  function isMailDoc(storagePath: string) {
    return storagePath.startsWith("vermietentwurf/");
  }

  async function deleteDoc(docId: string, storagePath: string, name: string) {
    const ok = await confirm({
      title: "Dokument löschen?",
      message: `"${name}" wird unwiderruflich entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
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
    if (!validateFileList(files)) return;
    setUploading(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setUploading(false); return; }

    for (const file of Array.from(files)) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `jobs/${id}/${Date.now()}_${safeName}`;
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("path", path);
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        const json = await res.json();
        if (!json.success) { TOAST.uploadError(json.error); continue; }
        await supabase.from("documents").insert({
          name: file.name, storage_path: path, file_size: file.size, mime_type: file.type,
          job_id: id as string, uploaded_by: user.id,
        });
      } catch (err) { TOAST.uploadError(err instanceof Error ? err.message : "Netzwerkfehler"); continue; }
    }
    toast.success("Datei(en) hochgeladen");
    loadAll();
    setUploading(false);
    e.target.value = "";
  }

  if (!job) return <Loading className="py-20" label="Laden…" />;

  // Bei Standort-Auftraegen ist customer NULL — der Verwaltungs-Kunde aus
  // location.customer wird als Fallback verwendet (zeigt z.B. "SCALA Verwaltung").
  // Da dieser Fallback nur Name+ID hat, faellt customerAddress dann leer aus.
  const customer = job.customer ?? job.location?.customer ?? undefined;
  const location = job.location ?? undefined;
  const room = job.room ?? undefined;
  const roomAddress = room ? [room.address_street, `${room.address_zip || ""} ${room.address_city || ""}`.trim()].filter(Boolean).join(", ") : "";
  const locationAddress = location ? [location.address_street, `${location.address_zip || ""} ${location.address_city || ""}`.trim()].filter(Boolean).join(", ") : "";
  // job.customer ist der „echte" Customer mit voller Adresse — nur den nutzen,
  // nicht den Verwaltungs-Fallback (der hat keine Adressfelder).
  const customerAddress = job.customer ? [job.customer.address_street, `${job.customer.address_zip || ""} ${job.customer.address_city || ""}`.trim()].filter(Boolean).join(", ") : "";
  // Maps-Suche: Standort > Raum > externe Adresse > Customer-Adresse > Name-Fallback.
  const mapsAddress = locationAddress || roomAddress || job.external_address || customerAddress;
  const mapsQuery = mapsAddress || location?.name || room?.name || customer?.name || "";
  const mapsUrl = mapsQuery ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}` : "";
  const projectLead = job.project_lead;

  async function decidePartnerAnfrage(decision: "accept" | "reject", message?: string) {
    setPartnerDecisionBusy(true);
    const res = await fetch(`/api/jobs/${id}/partner-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, message: message ?? "" }),
    });
    const json = await res.json();
    setPartnerDecisionBusy(false);
    if (!json.success) {
      toast.error(json.error ?? "Aktion fehlgeschlagen");
      return;
    }
    toast.success(decision === "accept" ? "Anfrage angenommen" : "Anfrage abgelehnt");
    setPartnerRejectOpen(false);
    setPartnerRejectReason("");
    window.dispatchEvent(new Event("jobs:invalidate"));
    await loadAll();
  }

  async function acceptPartnerAnfrage() {
    const ok = await confirm({
      title: "Partner-Anfrage annehmen?",
      message: "Die Anfrage wird ein offener Auftrag in eurer Pipeline. Der Partner sieht den Status danach read-only und kann nichts mehr ändern.",
      confirmLabel: "Annehmen",
      variant: "blue",
    });
    if (!ok) return;
    decidePartnerAnfrage("accept");
  }

  // Status-Aktionen — knapp: Freigeben (Entwurf → Bevorstehend), Abschliessen, Stornieren.
  // 'Starten' entfernt (siehe in_arbeit-Status weg).
  const statusActions: { from: JobStatus[]; to: JobStatus; label: string; icon: React.ReactNode; variant: "primary" | "outline" | "destructive" }[] = [
    { from: ["entwurf"], to: "offen", label: "Freigeben", icon: <CheckCircle className="h-4 w-4" />, variant: "primary" },
    { from: ["offen"], to: "abgeschlossen", label: "Abschliessen", icon: <CheckCircle className="h-4 w-4" />, variant: "outline" },
    { from: ["entwurf", "offen"], to: "storniert", label: "Stornieren", icon: <XCircle className="h-4 w-4" />, variant: "destructive" },
  ];

  const availableActions = statusActions.filter((a) => a.from.includes(job.status));
  const isDringend = job.priority === "dringend";
  // Archiv-Sperre: abgeschlossene + stornierte Auftraege sind read-only fuer
  // Loesch-Aktionen — sonst kann der User Dokumente aus historischen Auftraegen
  // wegloeschen und damit den Audit-Trail beschaedigen.
  const isArchivedJob = job.status === "abgeschlossen" || job.status === "storniert";

  // Abschliessen ist erst möglich, wenn das Enddatum erreicht ist
  const todayISO = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const endDateISO = job.end_date ? job.end_date.slice(0, 10) : null;
  const canFinish = !endDateISO || endDateISO <= todayISO;
  const finishBlockReason = !canFinish && endDateISO
    ? `Auftrag kann erst ab dem Enddatum (${new Date(endDateISO).toLocaleDateString("de-CH")}) abgeschlossen werden`
    : "";

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-4">
        <BackButton fallbackHref="/auftraege" />
        <div className="flex-1 min-w-0">
          <div className="space-y-1.5">
            <JobNumber number={job.job_number} size="md" />
            <h1 className="text-2xl font-bold tracking-tight">{job.title}</h1>
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            {/* Konsistent zur Liste: 'offen' = Default, kein Badge */}
            {job.status !== "offen" && (
              <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full ${JOB_STATUS[job.status].color}`}>{JOB_STATUS[job.status].label}</span>
            )}
            {isDringend && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300">
                <AlertCircle className="h-3 w-3" />
                Dringend
              </span>
            )}
            {job.was_anfrage && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-foreground/[0.06] text-muted-foreground"
                data-tooltip="Aus einem Vermietentwurf entstanden"
              >
                <Inbox className="h-3 w-3" />
                Vermietentwurf
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Partner-Anfrage-Banner: nur bei status='partner_anfrage'. Admin-
          Aktion via /api/jobs/[id]/partner-decision. */}
      {job.status === "partner_anfrage" && can("auftraege:edit") && (
        <Card className="bg-amber-50 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
              <div className="text-sm flex-1">
                <p className="font-semibold text-amber-800 dark:text-amber-200">Partner-Anfrage</p>
                <p className="text-amber-700 dark:text-amber-300 mt-0.5">
                  Diese Anfrage kam vom Location-Partner. Annahme = wird offener Auftrag. Ablehnung = Partner sieht den Grund.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={acceptPartnerAnfrage}
                disabled={partnerDecisionBusy}
                className="kasten kasten-green"
              >
                <CheckCircle className="h-3.5 w-3.5" />
                Annehmen
              </button>
              <button
                type="button"
                onClick={() => setPartnerRejectOpen(true)}
                disabled={partnerDecisionBusy}
                className="kasten kasten-red"
              >
                <XCircle className="h-3.5 w-3.5" />
                Ablehnen
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Aktionen: Status-Uebergaenge + Bearbeiten + Stornieren — alles im Kasten-Stil.
          "Abschliessen" oeffnet das Rapport-Modal — bleibt sichtbar fuer
          zugewiesene Techniker auch ohne auftraege:edit (RLS hat eigene
          Sonderregel fuer Job-Assignments). Stornieren / andere Status-
          Wechsel / Bearbeiten brauchen explizit auftraege:edit. */}
      <div className="flex flex-wrap gap-2">
        {availableActions
          .filter((a) => a.to !== "storniert")
          .filter((a) => a.to === "abgeschlossen" || can("auftraege:edit"))
          .map((a) => {
            const isFinish = a.to === "abgeschlossen";
            const isPrimary = a.variant === "primary";
            const tone = isFinish ? "kasten-green" : isPrimary ? "kasten-red" : "kasten-muted";
            // Freigeben braucht Datum — sonst landet ein offener Auftrag
            // ohne Termin in Liste/Kalender und ist unsichtbar in Counts.
            const isRelease = a.to === "offen";
            const releaseBlocked = isRelease && (!job.start_date || !job.end_date);
            return (
              <button
                key={a.to}
                type="button"
                onClick={() => updateStatus(a.to)}
                disabled={releaseBlocked}
                data-tooltip={releaseBlocked ? "Bitte erst Datum im Bearbeiten-Modus setzen" : undefined}
                className={`kasten ${tone}`}
              >
                {a.icon}
                {a.label}
              </button>
            );
          })}

        {/* Bearbeiten — nur bei Entwuerfen. Violet wie der Entwurf-Status-Tag,
            damit die Farbsprache app-weit konsistent ist (Bearbeiten == Entwurf-
            Aktion). */}
        {job.status === "entwurf" && can("auftraege:edit") && (
          <Link
            href={`/auftraege/${id}/bearbeiten`}
            className="kasten kasten-purple"
          >
            <Pencil className="h-3.5 w-3.5" />
            Bearbeiten
          </Link>
        )}

        {/* Stornieren als Letztes — auftraege:edit-only */}
        {can("auftraege:edit") && availableActions
          .filter((a) => a.to === "storniert")
          .map((a) => (
            <button
              key={a.to}
              type="button"
              onClick={() => setCancelPhase("confirm")}
              className="kasten kasten-red"
            >
              {a.icon}
              {a.label}
            </button>
          ))}

        {/* Stempel-Quick-Button — auch fuer Techniker ohne auftraege:edit
            verfuegbar (Stempelung gehoert zur Arbeitszeit-Erfassung). */}
        {(job.status === "offen" || job.status === "anfrage" || job.status === "entwurf") && (
          <JobStempelButton jobId={id as string} jobNumber={job.job_number} />
        )}
      </div>

      {/* End-Date-Hint: erklaert dass Final-Submit erst ab End-Datum geht,
          aber der Rapport schon jetzt vorbereitet werden kann (Auto-Save). */}
      {!canFinish && job.status === "offen" && finishBlockReason && (
        <p className="text-xs text-muted-foreground -mt-3 flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3" />
          {finishBlockReason} — Rapport kann jedoch schon jetzt vorbereitet werden.
        </p>
      )}

      {/* Info */}
      <Card className="bg-card">
        <CardContent className="p-5 space-y-3">
          {/* Kunde IMMER anzeigen — auch bei Location-Auftraegen wo der
              Customer der Verwaltungs-Kunde der Location ist. Falls weder
              direkt noch via Location ein Customer auflösbar: "—". */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5 text-sm">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium">Kunde:</span>
                <span className="truncate">{customer?.name ?? "—"}</span>
              </div>
              {customerAddress && (
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{customerAddress}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* BexioButton nur fuer echte job.customer-Verknuepfungen — der
                  Verwaltungs-Fallback (job.location.customer) hat nur id+name,
                  kein bexio_contact_id. Bexio-Sync findet auf der Customer-Seite statt. */}
              {job.customer?.id && (
                <BexioButton
                  customerId={job.customer.id}
                  bexioContactId={job.customer.bexio_contact_id ?? null}
                  onLinked={() => loadAll()}
                />
              )}
                {!location && mapsUrl && (
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="kasten kasten-blue"
                  >
                    <MapPin className="h-3.5 w-3.5" />
                    Google Maps
                  </a>
                )}
              </div>
            </div>
          {location && (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5 text-sm">
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-medium">Standort:</span>
                  <span className="truncate">{location.name}</span>
                </div>
                {locationAddress && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate">{locationAddress}</span>
                  </div>
                )}
              </div>
              {mapsUrl && (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="kasten kasten-blue shrink-0"
                >
                  <MapPin className="h-3.5 w-3.5" />
                  Google Maps
                </a>
              )}
            </div>
          )}
          {!location && room && (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5 text-sm">
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-medium">Raum:</span>
                  <span className="truncate">{room.name}</span>
                </div>
                {roomAddress && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate">{roomAddress}</span>
                  </div>
                )}
              </div>
              {mapsUrl && (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="kasten kasten-blue shrink-0"
                >
                  <MapPin className="h-3.5 w-3.5" />
                  Google Maps
                </a>
              )}
            </div>
          )}
          {!location && !room && job.external_address && (
            <div className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="font-medium">Ort:</span>
              <span className="truncate">{job.external_address}</span>
            </div>
          )}
          {projectLead && <div className="flex items-center gap-2 text-sm"><UserCheck className="h-4 w-4 text-muted-foreground" /><span className="font-medium">Projektleiter:</span> {projectLead.full_name}</div>}
          {job.start_date && <div className="flex items-center gap-2 text-sm"><Calendar className="h-4 w-4 text-muted-foreground" /><span className="font-medium">Event-Datum:</span> {new Date(job.start_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })} {job.end_date && job.end_date !== job.start_date ? `– ${new Date(job.end_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}` : ""}</div>}
          {/* Veranstalter-Kontakt — Person vor Ort, separat vom Customer.
              Nur sichtbar wenn mind. ein Feld gesetzt ist; bei extern-Auftraegen
              sind die Felder typisch null (Customer ist selber der Kontakt). */}
          {(job.contact_person || job.contact_phone || job.contact_email) && (
            <div className="pt-2 border-t space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Veranstalter-Kontakt</p>
              {job.contact_person && (
                <div className="flex items-center gap-2 text-sm">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span>{job.contact_person}</span>
                </div>
              )}
              {job.contact_phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <a href={`tel:${job.contact_phone.replace(/\s+/g, "")}`} className="hover:underline tabular-nums">{job.contact_phone}</a>
                </div>
              )}
              {job.contact_email && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <a href={`mailto:${job.contact_email}`} className="hover:underline truncate">{job.contact_email}</a>
                </div>
              )}
            </div>
          )}
          {job.description && <div className="pt-2 border-t"><p className="text-sm text-muted-foreground">{job.description}</p></div>}
        </CardContent>
      </Card>

      {/* Storno-Info — nur sichtbar wenn storniert */}
      {job.status === "storniert" && (job.cancelled_at || job.cancellation_reason) && (
        <Card className="bg-card border-destructive/30">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <XCircle className="h-4 w-4" />
              Storniert
            </div>
            <div className="text-sm text-muted-foreground">
              {job.cancelled_by_profile?.full_name && (
                <>von <span className="font-medium text-foreground">{job.cancelled_by_profile.full_name}</span></>
              )}
              {job.cancelled_at && (
                <> am <span className="font-medium text-foreground">{new Date(job.cancelled_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}</span></>
              )}
            </div>
            {job.cancellation_reason && (
              <div className="pt-2 border-t">
                <p className="text-xs text-muted-foreground mb-1">Grund</p>
                <p className="text-sm whitespace-pre-wrap">{job.cancellation_reason}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Partner-Custom-Felder — Antworten auf vom Admin im Builder hinzu-
          gefuegte Zusatz-Felder (Toggles, Textareas, etc.). Nur sichtbar
          wenn der Partner welche ausgefuellt hat. */}
      <PartnerFormAnswersCard
        formAnswers={job.form_answers}
        formSchemaSnapshot={job.form_schema_snapshot}
        locationId={job.location_id}
      />

      {/* Notizen — eine Freitext-Notiz, autosave nach 800ms ohne Aenderung */}
      <Card className="bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><StickyNote className="h-4 w-4" />Notizen</CardTitle>
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

      <AppointmentsSection
        jobId={id as string}
        jobTitle={job?.title ?? null}
        jobStatus={job.status}
        jobStartDate={job.start_date ?? null}
        appointments={appointments}
        profiles={profiles}
        onReload={loadAll}
        defaultOpen={autoOpenAppt}
      />

      {/* Einsatzrapporte */}
      <Card className="bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><FileText className="h-4 w-4" />Einsatzrapporte ({reports.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {reports.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">Noch keine Rapporte für diesen Auftrag.</p>
          ) : (
            <div className="space-y-2">
              {reports.map((r) => (
                <div key={r.id} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Rapport vom {new Date(r.report_date).toLocaleDateString("de-CH")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {r.creator?.full_name} · {r.status === "abgeschlossen" ? "Abgeschlossen" : "Entwurf"}
                    </p>
                  </div>
                  <a href={`/api/reports/${r.id}/pdf`} download={`Rapport_${r.report_date}.pdf`}>
                    <Button size="sm" variant="outline">
                      <Download className="h-4 w-4 mr-1" />PDF
                    </Button>
                  </a>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stundenkontrolle — Stempel- vs Rapport-Stunden pro Mitarbeiter.
          Admin-only, wird via SECURITY-DEFINER-RPC geladen. */}
      {isAdmin && audit.length > 0 && <HoursAuditCard rows={audit} />}

      {/* Dokumente / PDFs */}
      <Card className="bg-card">
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Upload className="h-4 w-4" />Dokumente ({documents.length})</CardTitle>
          <div className="flex items-center gap-2">
            <input type="file" id="jobFileUpload" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" className="hidden" onChange={handleFileUpload} />
            {/* Kamera-Capture: triggert auf Mobil die Kamera-App, auf Desktop faellt der Browser auf File-Picker zurueck.
                Button nur auf Mobile sichtbar — auf Desktop ist er redundant zum normalen Upload. */}
            <input type="file" id="jobPhotoUpload" accept="image/*" capture="environment" className="hidden" onChange={handleFileUpload} />
            <Button size="sm" variant="outline" className="md:hidden" onClick={() => document.getElementById("jobPhotoUpload")?.click()} disabled={uploading}>
              <Camera className="h-4 w-4 mr-1" />Foto
            </Button>
            <Button size="sm" variant="outline" onClick={() => document.getElementById("jobFileUpload")?.click()} disabled={uploading}>
              <Upload className="h-4 w-4 mr-1" />{uploading ? "Lädt…" : "Hochladen"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">Keine Dokumente. Klicke auf "Hochladen" um PDFs/Dateien anzuhängen.</p>
          ) : (
            <div className="space-y-2">
              {documents.map((doc) => {
                const fromMail = isMailDoc(doc.storage_path);
                return (
                  <div key={doc.id} className="flex items-center justify-between p-3 rounded-xl bg-gray-50 border border-gray-100">
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText className="h-5 w-5 text-red-500 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{doc.name}</p>
                        <p className="text-xs text-muted-foreground">{doc.file_size ? (doc.file_size / 1024).toFixed(0) + " KB" : ""} · {new Date(doc.created_at).toLocaleDateString("de-CH")}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* Trash links, Download rechts. Bei Mail-Doks Trash unsichtbar (visibility:hidden),
                          aber Platz reservieren — so verschiebt sich der Download-Pfeil nie.
                          Bei archivierten Auftraegen (abgeschlossen/storniert) ebenfalls
                          unsichtbar: Archiv ist app-weit read-only fuer Loesch-Aktionen. */}
                      <button
                        type="button"
                        onClick={() => deleteDoc(doc.id, doc.storage_path, doc.name)}
                        className={`kasten kasten-red ${fromMail || isArchivedJob ? "invisible pointer-events-none" : ""}`}
                        data-tooltip="Löschen"
                        aria-hidden={fromMail || isArchivedJob || undefined}
                        tabIndex={fromMail || isArchivedJob ? -1 : undefined}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
                          if (error || !data?.signedUrl) {
                            toast.error("Datei nicht verfügbar — eventuell aus altem Bestand vor 6.5.2026, im alten Storage zu finden");
                            return;
                          }
                          setPreviewDoc({ url: data.signedUrl, title: doc.name });
                        }}
                        className="kasten kasten-blue"
                        data-tooltip="Vorschau"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.storage_path, 3600);
                          if (error || !data?.signedUrl) {
                            toast.error("Datei nicht verfügbar — eventuell aus altem Bestand vor 6.5.2026, im alten Storage zu finden");
                            return;
                          }
                          const a = document.createElement("a");
                          a.href = data.signedUrl;
                          a.download = doc.name;
                          a.click();
                        }}
                        className="kasten kasten-muted"
                        data-tooltip="Herunterladen"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      {/* Partner-Anfrage ablehnen — Reason-Modal */}
      <Modal
        open={partnerRejectOpen}
        onClose={() => { setPartnerRejectOpen(false); setPartnerRejectReason(""); }}
        title="Anfrage ablehnen?"
        closable={!partnerDecisionBusy}
      >
        <p className="text-sm text-muted-foreground">
          Der Partner sieht den Grund als Erklärung in seinem Portal.
        </p>
        <textarea
          placeholder="z.B. Datum nicht verfügbar, Personalmangel…"
          value={partnerRejectReason}
          onChange={(e) => setPartnerRejectReason(e.target.value)}
          rows={3}
          autoFocus
          className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
          style={{ fieldSizing: "content" } as React.CSSProperties}
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { setPartnerRejectOpen(false); setPartnerRejectReason(""); }}
            disabled={partnerDecisionBusy}
            className="kasten kasten-muted flex-1"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => decidePartnerAnfrage("reject", partnerRejectReason.trim())}
            disabled={partnerDecisionBusy || !partnerRejectReason.trim()}
            className="kasten kasten-red flex-1"
          >
            {partnerDecisionBusy ? "Speichere…" : "Ablehnen"}
          </button>
        </div>
      </Modal>

      {/* Stornieren-Flow: Phase 'confirm' -> 'reason' */}
      <Modal
        open={cancelPhase !== "closed"}
        onClose={() => { setCancelPhase("closed"); setCancelReason(""); }}
        title={cancelPhase === "confirm" ? "Auftrag stornieren?" : "Grund angeben"}
        closable={!cancelSaving}
      >
        <p className="text-sm text-muted-foreground">
          {job.job_number ? `INT-${job.job_number} — ` : ""}
          <span className="font-medium text-foreground">&quot;{job.title}&quot;</span>
        </p>
        {cancelPhase === "confirm" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Der Auftrag wird als storniert markiert. Du kannst ihn im Archiv wieder einsehen.
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
              Bitte gib einen Grund an, warum dieser Auftrag storniert wird.
            </p>
            <textarea
              placeholder="z.B. Kunde hat abgesagt, Termin verschoben…"
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

      {ConfirmModalElement}

      {previewDoc && (
        <PdfPopup
          url={previewDoc.url}
          title={previewDoc.title}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {/* Einsatzrapport-Modal — geoeffnet via "Abschliessen"-Button. Beim
          Submit wird Rapport gespeichert + Auftrag-Status atomar auf
          'abgeschlossen' gesetzt. onCompleted reloaded die Detail-Page. */}
      <RapportFormModal
        open={showRapportModal}
        onClose={() => setShowRapportModal(false)}
        job={{
          id: id as string,
          title: job.title,
          job_number: job.job_number,
          customer_name: customer?.name ?? null,
          location_name: location?.name ?? room?.name ?? null,
        }}
        onCompleted={loadAll}
        canFinish={canFinish}
        finishBlockReason={finishBlockReason}
        isMaintenance={isMaintenanceJob}
      />
    </div>
  );
}
