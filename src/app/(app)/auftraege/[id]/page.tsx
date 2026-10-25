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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { tabelleAbonnieren } from "@/lib/realtime";
import { JOB_STATUS } from "@/lib/constants";
import type { JobStatus } from "@/types";
import { CheckCircle, XCircle, Info, FileText, Upload, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { localDateIso } from "@/lib/swiss-time";
import { Loading } from "@/components/ui/spinner";
import { usePermissions } from "@/lib/use-permissions";
import { useIsMobile } from "@/lib/use-is-mobile";
import { auftragArchiviert, auftragStornoVon, vermerk } from "@/lib/archiv";
import { ArchivHinweis } from "@/components/ui/archiv-hinweis";
import { AuftragFeld } from "@/components/mobile/auftrag-feld";
import AuftragLoading from "./loading";

// Rapport-Kette (Formular + Zeit-/Foto-/Signatur-Sections inkl.
// react-signature-canvas) nur laden, wenn das Modal wirklich oeffnet —
// sonst haengen ~60 KB Formular-Code im Chunk der meistbesuchten
// Detail-Route, obwohl der Rapport nur einmal pro Auftrag passiert
// (Perf-Audit). Fallback = Modal-Backdrop + Spinner (§7, z-Werte wie
// ui/modal.tsx), damit der Klick auf "Abschliessen" sofort Feedback zeigt.
const RapportFormModal = dynamic(
  () => import("@/components/auftrag/rapport-form-modal").then((m) => m.RapportFormModal),
  {
    ssr: false,
    loading: () => (
      <>
        <div className="fixed inset-0 z-[1100] bg-black/60 backdrop-blur" />
        <div className="fixed inset-0 z-[1110] flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-white" />
        </div>
      </>
    ),
  },
);

import { AuftragStickyHeader, type TabKey } from "@/components/auftrag/tabs/sticky-header";
import { AuftragNextActionChip } from "@/components/auftrag/next-action-chip";
import { AuftragModals } from "@/components/auftrag/tabs/auftrag-modals";
import { PartnerAnfrageBanner } from "@/components/auftrag/tabs/partner-anfrage-banner";
import { OverviewTab } from "@/components/auftrag/tabs/overview-tab";
import { RapportTab } from "@/components/auftrag/tabs/rapport-tab";
import { DocsHistoryTab } from "@/components/auftrag/tabs/docs-history-tab";
import { TechnikTab } from "@/components/auftrag/technik/technik-tab";
import { useAuftragData } from "@/components/auftrag/tabs/use-auftrag-data";

export default function AuftragDetailPage() {
  // Weiche (Mobile-Overhaul): am Handy (< md) die Feldansicht ohne Tabs
  // (src/components/mobile/auftrag-feld.tsx); Desktop rendert exakt den
  // bisherigen Baum. «Breite noch unbekannt» (null, nur SSR/Hydration) zeigt
  // das Routen-Skelett ohne Effekte, damit useAuftragData nicht in einem Baum
  // startet, der gleich wieder ausgetauscht wird. Als Wrapper, damit die
  // Hook-Reihenfolge des Desktop-Baums unveraendert bleibt.
  const { id } = useParams();
  const isMobile = useIsMobile();
  if (isMobile === null) return <AuftragLoading />;
  if (isMobile) return <AuftragFeld jobId={id as string} />;
  return <AuftragDetailDesktop />;
}

function AuftragDetailDesktop() {
  const { id } = useParams();
  const jobId = id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const { can, ready: permsReady, role } = usePermissions();
  // Effektive Rolle aus dem PermissionsProvider (/api/me) — der Hook holte
  // sie frueher selbst via getUser+profiles.role (doppelter Fetch, Perf-Audit).
  const isAdmin = role === "admin";

  const {
    job,
    appointments,
    documents,
    profiles,
    reports,
    audit,
    setDocuments,
    notesText,
    setNotesText,
    loadAll,
  } = useAuftragData(jobId, { isAdmin, permsReady });

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
  const isValidTab = urlTab === "uebersicht" || urlTab === "technik" || urlTab === "rapport" || urlTab === "dokumente";
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

  // ─── Technik: offene Lieferanten-Punkte am Tab + Live-Aktualisierung ──
  // Zahl aus der DB (technik_offene_punkte, Migration 331): offene
  // Empfehlungen + Probleme + unbeantwortete Kommentare des Lieferanten.
  // Realtime auf job_technik_aktivitaet DIESES Auftrags: jede Aktion
  // (Firma oder Portal) schreibt Aktivitaet → Zahl neu + der offene
  // Technik-Tab laedt nach (Event «technik:aktualisieren»).
  const [technikOffen, setTechnikOffen] = useState(0);
  const technikZaehlen = useCallback(async () => {
    const { data, error } = await supabase.rpc("technik_offene_punkte", { p_job_id: jobId });
    if (!error && typeof data === "number") setTechnikOffen(data);
  }, [supabase, jobId]);
  useEffect(() => {
    // queueMicrotask wie oben (react-hooks/set-state-in-effect): erster
    // Zaehlstand ohne Kaskaden-Render.
    queueMicrotask(() => { void technikZaehlen(); });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const geaendert = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void technikZaehlen();
        window.dispatchEvent(new CustomEvent("technik:aktualisieren", { detail: { jobId } }));
      }, 400);
    };
    // Login-Token vor dem Beitritt stellt der Browser-Client zentral sicher
    // (src/lib/supabase/client.ts) — auch nach F5/Direktlink.
    const abmelden = tabelleAbonnieren(supabase, {
      tabelle: "job_technik_aktivitaet",
      ereignis: "INSERT",
      filter: `job_id=eq.${jobId}`,
      beiAenderung: geaendert,
      // Bei jedem (Wieder-)Beitritt einmal frisch zaehlen — Aenderungen
      // waehrend eines Netz-Unterbruchs kommen sonst nicht nach.
      beiStatus: (ok) => { if (ok) void technikZaehlen(); },
    });
    return () => {
      abmelden();
      if (timer) clearTimeout(timer);
    };
  }, [supabase, jobId, technikZaehlen]);

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

  // Bewusst KEINE Breadcrumbs (2026-10-02): Zurueck-Pfeil + Nummer im
  // Kopf reichen, und die globale Zeile ueber dem Inhalt liess den
  // Sticky-Kopf beim Scrollen erst ein Stueck mitlaufen.
  if (!job) return <Loading className="py-20" label="Laden…" />;

  // ─── Derived ────────────────────────────────────────────────────
  const customer = job.customer ?? job.location?.customer ?? undefined;
  const location = job.location ?? undefined;
  const room = job.room ?? undefined;
  // Archiv = nur lesen (Leo 2026-10-15, src/lib/archiv.ts): abgeschlossene und
  // stornierte Auftraege zeigen alles, aber kein Reiter bietet Bearbeiten an.
  // darfBearbeiten ist der EINE Schalter fuer alle Reiter; die DB (Migration
  // 342) und die API-Routen sperren zusaetzlich.
  const nurLesen = auftragArchiviert(job.status);
  const darfBearbeiten = canEditJob && !nurLesen;

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

  const tabs: { key: TabKey; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: "uebersicht", label: "Übersicht", icon: <Info className="h-4 w-4" /> },
    { key: "technik", label: "Technik & Plan", icon: <Wrench className="h-4 w-4" />, badge: technikOffen > 0 ? technikOffen : undefined },
    { key: "rapport", label: "Rapport & Abschluss", icon: <FileText className="h-4 w-4" /> },
    { key: "dokumente", label: "Dokumente & Historie", icon: <Upload className="h-4 w-4" /> },
  ];

  return (
    <div className="max-w-5xl mx-auto page-enter">
      <AuftragStickyHeader
        jobId={jobId}
        job={job}
        canEdit={darfBearbeiten}
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

      {/* Archiv-Hinweis ueber allen Reitern — bei stornierten Auftraegen mit
          Storno-Vermerk und Begruendung (intern; die Portale zeigen ihn nicht). */}
      {nurLesen && (
        <ArchivHinweis
          className="-mt-4 mb-4"
          vermerk={
            job.status === "storniert"
              ? vermerk("Storniert", job.cancelled_at, auftragStornoVon(job))
              : "Auftrag abgeschlossen"
          }
          begruendung={job.status === "storniert" ? job.cancellation_reason : null}
        />
      )}

      {/* Tab-Body: bei abgeschlossenen/stornierten Auftraegen visuell zurueckgenommen. */}
      <div className={nurLesen ? "opacity-80 grayscale" : undefined}>
        {activeTab === "uebersicht" && (
          <OverviewTab
            jobId={jobId}
            job={job}
            canEdit={darfBearbeiten}
            nurLesen={nurLesen}
            eingangSichtbar={canEditJob}
            appointments={appointments}
            profiles={profiles}
            autoOpenAppt={autoOpenAppt}
            onReload={loadAll}
            notesText={notesText}
            setNotesText={setNotesText}
          />
        )}
        {activeTab === "technik" && (
          <TechnikTab
            jobId={jobId}
            canEdit={darfBearbeiten}
            onAenderung={technikZaehlen}
            // Der Archiv-Hinweis oben gilt fuer alle Reiter — kein zweiter
            // Sperr-Hinweis im Technik-Tab (canEdit ist bereits false).
            sperrHinweis={null}
          />
        )}
        {activeTab === "rapport" && <RapportTab reports={reports} isAdmin={isAdmin} audit={audit} />}
        {activeTab === "dokumente" && (
          <DocsHistoryTab
            jobId={jobId}
            job={job}
            documents={documents}
            isArchivedJob={nurLesen}
            onDocumentsChange={setDocuments}
            canEdit={darfBearbeiten}
            onReload={loadAll}
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

      {/* Einsatzrapport-Modal — geoeffnet via "Abschliessen"-Button.
          Erst beim Oeffnen gemountet (next/dynamic laedt den Chunk dann
          nach); das Modal rendert bei !open ohnehin null und laedt seinen
          State bei jedem Oeffnen frisch aus der DB. */}
      {showRapportModal && (
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
      )}
    </div>
  );
}
