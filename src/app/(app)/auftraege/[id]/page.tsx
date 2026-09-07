"use client";

/**
 * Auftrag-Detail — Sticky-Header + 3-Tab-Layout (Audit Thema 1).
 *
 * Struktur:
 *  - Sticky-Header oben: BackButton, Nummer/Titel, Status-Badges, Meta-Zeile
 *    (Kunde/Standort/Datum), Aktions-Bar (Freigeben / Abschliessen /
 *    Stornieren direkt als Buttons, farbgetrennt) und Tab-Nav.
 *    (→ tabs/sticky-header.tsx)
 *  - Body: EIN Tab sichtbar (Uebersicht | Rapport & Abschluss | Dokumente & Historie).
 *  - Modals: Cancel-Flow, Partner-Reject (→ tabs/auftrag-modals.tsx), Rapport.
 *
 * Rollen-Default:
 *   admin / teamleiter → Uebersicht
 *   mitarbeiter / techniker / partner → Rapport
 *
 * Tab-State lebt in der URL (?tab=uebersicht|rapport|dokumente), damit ein
 * Reload den gewuenschten Tab beibehaelt und Links teilbar sind.
 *
 * Alle Datenladung + Autosave lebt in `use-auftrag-data.ts`, damit page.tsx
 * unter 400 LOC bleibt.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { JOB_STATUS } from "@/lib/constants";
import type { JobStatus } from "@/types";
import { CheckCircle, XCircle, Info, FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { localDateIso } from "@/lib/swiss-time";
import { RapportFormModal } from "@/components/auftrag/rapport-form-modal";
import { Loading } from "@/components/ui/spinner";
import { usePermissions } from "@/lib/use-permissions";

import { AuftragStickyHeader, type TabKey } from "@/components/auftrag/tabs/sticky-header";
import { AuftragNextActionChip } from "@/components/auftrag/next-action-chip";
import { AuftragModals } from "@/components/auftrag/tabs/auftrag-modals";
import { PartnerAnfrageBanner } from "@/components/auftrag/tabs/partner-anfrage-banner";
import { OverviewTab } from "@/components/auftrag/tabs/overview-tab";
import { RapportTab } from "@/components/auftrag/tabs/rapport-tab";
import { DocsHistoryTab } from "@/components/auftrag/tabs/docs-history-tab";
import { useAuftragData } from "@/components/auftrag/tabs/use-auftrag-data";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";

export default function AuftragDetailPage() {
  const { id } = useParams();
  const jobId = id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const { can, ready: permsReady } = usePermissions();

  const {
    job,
    appointments,
    documents,
    profiles,
    reports,
    isAdmin,
    audit,
    setDocuments,
    notesText,
    setNotesText,
    verwaltungsText,
    setVerwaltungsText,
    verwaltungsMinutes,
    setVerwaltungsMinutes,
    loadAll,
  } = useAuftragData(jobId);

  const [showRapportModal, setShowRapportModal] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // Aktueller User — benoetigt fuer die NextAction-Chip-Regeln
  // ("Rapport fortsetzen" nur wenn ownDraft, "Rapport starten" nur wenn
  // heute assigned). Bewusst separat vom Permissions-Hook: der liefert
  // Rolle+Rechte, nicht die auth-User-ID.
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
    });
  }, [supabase]);

  const [cancelPhase, setCancelPhase] = useState<"closed" | "confirm" | "reason">("closed");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelSaving, setCancelSaving] = useState(false);
  const [partnerRejectOpen, setPartnerRejectOpen] = useState(false);
  const [partnerRejectReason, setPartnerRejectReason] = useState("");
  const [partnerDecisionBusy, setPartnerDecisionBusy] = useState(false);

  // Auto-open-Termin-Form: ?termin=neu → Termin-Formular aufmachen. Wir
  // strippen nur den termin-Param, der tab-Param bleibt erhalten.
  const autoOpenAppt = searchParams.get("termin") === "neu";
  useEffect(() => {
    if (!autoOpenAppt) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("termin");
    const qs = params.toString();
    router.replace(`/auftraege/${jobId}${qs ? `?${qs}` : ""}`, { scroll: false });
    setTimeout(() => {
      document.getElementById("termin-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
  }, [autoOpenAppt, jobId, router, searchParams]);

  // Auto-scroll zur Termine-Section: ?scroll=termine (vom "Personal
  // zuteilen"-Chip). Nur scrollen, Form nicht aufmachen. Param wird
  // gestrippt damit der Reload nicht erneut scrollt.
  const scrollTarget = searchParams.get("scroll");
  useEffect(() => {
    if (scrollTarget !== "termine") return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("scroll");
    const qs = params.toString();
    router.replace(`/auftraege/${jobId}${qs ? `?${qs}` : ""}`, { scroll: false });
    setTimeout(() => {
      document.getElementById("termin-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }, [scrollTarget, jobId, router, searchParams]);

  // Auto-open Rapport-Modal via ?openDraft=1 (Dashboard-Bruecke). Weiterleitet
  // den User direkt in seinen offenen Rapport-Entwurf; Param wird gestrippt
  // damit ein Reload das Modal nicht immer wieder aufmacht. setState via
  // queueMicrotask, damit React nicht in eine cascading-render-Runde faellt
  // (siehe react-hooks/set-state-in-effect).
  const autoOpenDraft = searchParams.get("openDraft") === "1";
  useEffect(() => {
    if (!autoOpenDraft) return;
    queueMicrotask(() => setShowRapportModal(true));
    const params = new URLSearchParams(searchParams.toString());
    params.delete("openDraft");
    const qs = params.toString();
    router.replace(`/auftraege/${jobId}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [autoOpenDraft, jobId, router, searchParams]);

  // ─── Tab-Auswahl (URL-State + Rollen-Default) ──────────────────
  // Rollen, die ihre Arbeit ueber den Rapport-Tab machen (mitarbeiter,
  // techniker, partner), landen dort per Default — abgeleitet aus der
  // Permission: wer NICHT auftraege:edit hat, ist ausfuehrende Rolle und
  // arbeitet primaer am Rapport. Vorher: hardcoded Rollen-Slugs — jetzt
  // permission-driven, damit neue Rollen ohne Code-Aenderung greifen.
  const urlTab = searchParams.get("tab") as TabKey | null;
  const isValidTab = urlTab === "uebersicht" || urlTab === "rapport" || urlTab === "dokumente";
  const canEditJob = can("auftraege:edit");
  const roleDefault: TabKey = useMemo(
    () => (canEditJob ? "uebersicht" : "rapport"),
    [canEditJob],
  );
  const activeTab: TabKey = isValidTab ? (urlTab as TabKey) : roleDefault;

  // Sobald die Rolle geladen ist und die URL noch keinen tab-Param hat,
  // den rollenbasierten Default reinschreiben — teilbar + reload-persistent.
  useEffect(() => {
    if (!permsReady || isValidTab) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", roleDefault);
    router.replace(`/auftraege/${jobId}?${params.toString()}`, { scroll: false });
  }, [permsReady, isValidTab, roleDefault, jobId, router, searchParams]);

  function selectTab(next: TabKey) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/auftraege/${jobId}?${params.toString()}`, { scroll: false });
  }

  // ─── Status-Aktionen ────────────────────────────────────────────
  async function updateStatus(newStatus: JobStatus) {
    if (newStatus === "abgeschlossen") {
      setShowRapportModal(true);
      return;
    }
    if (newStatus === "offen" && job && (!job.start_date || !job.end_date)) {
      toast.error("Bitte erst Start- und Enddatum im Bearbeiten-Modus setzen, dann freigeben");
      return;
    }
    // Error-Check zwingend — sonst schluckt der Aufruf RLS-Fehler und
    // meldet dem User faelschlich "Erfolg" waehrend der Status in der DB
    // unveraendert bleibt (Audit-Finding, CLAUDE.md §6).
    const { error } = await supabase.from("jobs").update({ status: newStatus }).eq("id", jobId);
    if (error) {
      TOAST.supabaseError(error);
      return;
    }
    toast.success(`Status auf "${JOB_STATUS[newStatus].label}" geändert`);
    loadAll();
  }

  async function confirmCancel() {
    if (!cancelReason.trim()) {
      toast.error("Bitte einen Grund angeben");
      return;
    }
    setCancelSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("jobs")
      .update({
        status: "storniert",
        cancelled_by: user?.id ?? null,
        cancelled_at: new Date().toISOString(),
        cancellation_reason: cancelReason.trim(),
      })
      .eq("id", jobId);
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

  async function rejectPartnerAnfrage(reason: string) {
    setPartnerDecisionBusy(true);
    const res = await fetch(`/api/jobs/${jobId}/partner-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "reject", message: reason }),
    });
    const json = await res.json();
    setPartnerDecisionBusy(false);
    if (!json.success) {
      toast.error(json.error ?? "Aktion fehlgeschlagen");
      return;
    }
    toast.success("Anfrage abgelehnt");
    setPartnerRejectOpen(false);
    setPartnerRejectReason("");
    window.dispatchEvent(new Event("jobs:invalidate"));
    await loadAll();
  }

  // Globale Breadcrumbs: "Aufträge/Vermietentwürfe › INT-XXXX · Kunde".
  // Hook muss vor dem early-return laufen (Regeln der Hooks).
  const bcLabel = (() => {
    if (!job) return "";
    const nrLabel = job.job_number ? `INT-${job.job_number}` : "INT-…";
    const cust = job.customer?.name ?? job.location?.customer?.name ?? null;
    const loc = job.location?.name ?? null;
    const suffix = cust ?? loc ?? job.title ?? "";
    return suffix ? `${nrLabel} · ${suffix}` : nrLabel;
  })();
  useBreadcrumbs(
    job
      ? [
          job.status === "anfrage"
            ? { label: "Vermietentwürfe", href: "/auftraege" }
            : { label: "Aufträge", href: "/auftraege" },
          { label: bcLabel },
        ]
      : [],
  );

  if (!job) return <Loading className="py-20" label="Laden…" />;

  // ─── Derived ────────────────────────────────────────────────────
  const customer = job.customer ?? job.location?.customer ?? undefined;
  const location = job.location ?? undefined;
  const room = job.room ?? undefined;
  const isArchivedJob = job.status === "abgeschlossen" || job.status === "storniert";

  const todayISO = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const endDateISO = job.end_date ? localDateIso(new Date(job.end_date)) : null;
  const canFinish = !endDateISO || endDateISO <= todayISO;
  const finishBlockReason =
    !canFinish && endDateISO
      ? `Auftrag kann erst ab dem Enddatum (${new Date(job.end_date!).toLocaleDateString("de-CH", {
          timeZone: "Europe/Zurich",
        })}) abgeschlossen werden`
      : "";

  // Auftraege haben ab 2026-09 nur noch den Lebenszyklus offen → abgeschlossen
  // | storniert. Der "entwurf"-Status ist mit Migration 206 in die eigene
  // Tabelle job_drafts (siehe /entwuerfe) ausgezogen — bestehende jobs mit
  // status='entwurf' wurden dabei auf is_deleted=true gesetzt.
  const statusActions = [
    {
      from: ["offen"] as JobStatus[],
      to: "abgeschlossen" as JobStatus,
      label: "Abschliessen",
      icon: <CheckCircle className="h-4 w-4" />,
      variant: "outline" as const,
    },
    {
      // partner_anfrage kann durch Admin manuell storniert werden falls
      // der Partner nicht antwortet — sonst haengt der Auftrag stuck (der
      // PartnerAnfrageBanner ist nur der positive Weg via Aufnehmen/Ablehnen).
      from: ["offen", "partner_anfrage"] as JobStatus[],
      to: "storniert" as JobStatus,
      label: "Stornieren",
      icon: <XCircle className="h-4 w-4" />,
      variant: "destructive" as const,
    },
  ];
  const availableActions = statusActions.filter((a) => a.from.includes(job.status));

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: "uebersicht", label: "Uebersicht", icon: <Info className="h-4 w-4" /> },
    { key: "rapport", label: "Rapport & Abschluss", icon: <FileText className="h-4 w-4" /> },
    { key: "dokumente", label: "Dokumente & Historie", icon: <Upload className="h-4 w-4" /> },
  ];

  return (
    <div className="max-w-3xl mx-auto page-enter">
      <AuftragStickyHeader
        jobId={jobId}
        job={job}
        canEdit={canEditJob}
        availableActions={availableActions}
        onStatusAction={updateStatus}
        onOpenCancel={() => setCancelPhase("confirm")}
        canFinish={canFinish}
        finishBlockReason={finishBlockReason}
        tabs={tabs}
        activeTab={activeTab}
        onSelectTab={selectTab}
        onReload={loadAll}
        nextActionChip={
          <AuftragNextActionChip
            jobId={jobId}
            job={job}
            appointments={appointments}
            reports={reports.map((r) => ({ id: r.id, status: r.status, created_by: r.created_by }))}
            currentUserId={currentUserId}
            onOpenRapport={() => setShowRapportModal(true)}
            onRelease={() => updateStatus("offen")}
          />
        }
      />

      {job.status === "partner_anfrage" && can("auftraege:edit") && (
        <PartnerAnfrageBanner
          jobId={jobId}
          onDecided={loadAll}
          onOpenReject={() => setPartnerRejectOpen(true)}
        />
      )}

      {/* Tab-Body: bei abgeschlossenen/stornierten Auftraegen visuell zurueckgenommen. */}
      <div className={isArchivedJob ? "opacity-80 grayscale" : undefined}>
        {activeTab === "uebersicht" && (
          <OverviewTab
            jobId={jobId}
            job={job}
            appointments={appointments}
            profiles={profiles}
            autoOpenAppt={autoOpenAppt}
            onReload={loadAll}
            canEdit={canEditJob}
            notesText={notesText}
            setNotesText={setNotesText}
            verwaltungsText={verwaltungsText}
            setVerwaltungsText={setVerwaltungsText}
            verwaltungsMinutes={verwaltungsMinutes}
            setVerwaltungsMinutes={setVerwaltungsMinutes}
          />
        )}
        {activeTab === "rapport" && <RapportTab reports={reports} isAdmin={isAdmin} audit={audit} />}
        {activeTab === "dokumente" && (
          <DocsHistoryTab
            jobId={jobId}
            job={job}
            documents={documents}
            isArchivedJob={isArchivedJob}
            onReload={loadAll}
            onDocumentsChange={setDocuments}
          />
        )}
      </div>

      <AuftragModals
        jobNumber={job.job_number}
        jobTitle={job.title}
        cancelPhase={cancelPhase}
        cancelReason={cancelReason}
        cancelSaving={cancelSaving}
        onCancelClose={() => {
          setCancelPhase("closed");
          setCancelReason("");
        }}
        onSetCancelPhase={setCancelPhase}
        onSetCancelReason={setCancelReason}
        onConfirmCancel={confirmCancel}
        partnerRejectOpen={partnerRejectOpen}
        partnerRejectReason={partnerRejectReason}
        partnerDecisionBusy={partnerDecisionBusy}
        onPartnerRejectClose={() => {
          setPartnerRejectOpen(false);
          setPartnerRejectReason("");
        }}
        onSetPartnerRejectReason={setPartnerRejectReason}
        onPartnerReject={rejectPartnerAnfrage}
      />

      {/* Einsatzrapport-Modal — geoeffnet via "Abschliessen"-Button. */}
      <RapportFormModal
        open={showRapportModal}
        onClose={() => setShowRapportModal(false)}
        job={{
          id: jobId,
          title: job.title,
          job_number: job.job_number,
          customer_name: customer?.name ?? null,
          location_name: location?.name ?? room?.name ?? null,
        }}
        onCompleted={loadAll}
        canFinish={canFinish}
        finishBlockReason={finishBlockReason}
      />
    </div>
  );
}
