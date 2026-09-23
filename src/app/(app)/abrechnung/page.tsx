"use client";

/**
 * Abrechnung — zwei parallele Ablage-Streams.
 *
 *  LINKS  — Auftraege (status='abgeschlossen', invoiced_at IS NULL):
 *           Header, Arbeitsrapport, Stunden, Button "Rechnung gestellt".
 *           Modal asks fuer RE-Nummer.
 *
 *  RECHTS — Belege (type='beleg', filed_at IS NULL, status != 'abgelehnt'):
 *           Header (Lieferant, Betrag, Kaufdatum), Description, Button
 *           "Beleg abgelegt". Modal asks fuer Ablage-Referenz (BL-Nummer).
 *
 * Beide Streams laufen unabhaengig — Permission-Gate ueber abrechnung:edit
 * fuer beide Buttons.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Receipt, FileText, Clock, CheckCircle2, FolderArchive, XCircle, Eye, Ban, Info, MoreVertical, Loader2, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { ENTITY_PREFIX, formatJobNumber, formatTicketNumber } from "@/lib/nummern-format";
import { JOB_FIELDS } from "@/lib/constants";
import { usePermissions } from "@/lib/use-permissions";
import { useConfirm } from "@/components/ui/use-confirm";
import Link from "next/link";
import type { TicketDataBeleg } from "@/types";
import { PdfPopup } from "@/components/pdf-popup";
import { BackButton } from "@/components/ui/back-button";

// =====================================================================
// Auftrags-Stream (links)
// =====================================================================

interface TimeRange {
  date: string;
  start: string;
  end: string;
  pause: number;
  technician_id: string;
  not_billable?: boolean;
  not_billable_reason?: string;
}

interface ServiceReportData {
  id: string;
  work_description: string;
  equipment_used: string | null;
  issues: string | null;
  report_date: string;
  pdf_url: string | null;
  time_ranges: TimeRange[] | null;
}

interface TimeEntryData {
  id: string;
  user_id: string;
  clock_in: string;
  clock_out: string | null;
  user: { full_name: string } | null;
}

interface UnbilledJob {
  id: string;
  job_number: number | null;
  title: string;
  start_date: string | null;
  end_date: string | null;
  customer: { name: string } | null;
  location: { name: string } | null;
  service_reports: ServiceReportData[];
  time_entries: TimeEntryData[];
}

const JOBS_SELECT = `
  ${JOB_FIELDS.core}, ${JOB_FIELDS.zeitraum},
  ${JOB_FIELDS.kunde},
  ${JOB_FIELDS.location},
  service_reports(id, work_description, equipment_used, issues, report_date, pdf_url, time_ranges),
  time_entries(id, user_id, clock_in, clock_out, user:profiles!time_entries_profile_id_fkey(full_name))
`.replace(/\s+/g, " ").trim();

// =====================================================================
// Belege-Stream (rechts)
// =====================================================================

interface UnfiledBeleg {
  id: string;
  ticket_number: number;
  title: string;
  description: string | null;
  status: string;
  data: TicketDataBeleg;
  created_at: string;
  creator: { full_name: string } | null;
}

const BELEGE_SELECT = `
  id, ticket_number, title, description, status, data, created_at,
  creator:profiles!tickets_created_by_fkey(full_name)
`.replace(/\s+/g, " ").trim();

// Seitengroesse beider Streams. PAGE_SIZE+1-Trick (Muster kunden-view):
// eine Zeile mehr laden als angezeigt wird → hasMore ohne zweite Query.
// "Mehr laden" laedt range-basiert nach (Sortierung ist stabil), der
// echte Gesamtbestand kommt aus separaten head:true-Count-Queries —
// so verschwinden unverrechnete Auftraege nie still hinter einem Limit.
const PAGE_SIZE = 100;

// =====================================================================
// Helpers
// =====================================================================

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // timeZone Europe/Zurich zwingend — sonst rendert ein Event-Datum das in
  // der DB als '2026-06-13T22:00:00+00:00' (= 14.06 00:00 Zurich) als
  // 13.06 weil das UTC-Datum genommen wird. .split("T")[0] hatte den
  // gleichen Bug.
  return new Date(iso).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatHours(totalMinutes: number): string {
  if (totalMinutes <= 0) return "0h";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function aggregatePerUser(entries: TimeEntryData[]): Map<string, { name: string; minutes: number }> {
  const byUser = new Map<string, { name: string; minutes: number }>();
  for (const e of entries) {
    if (!e.clock_out) continue;
    const minutes = Math.round((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000);
    const name = e.user?.full_name ?? "Unbekannt";
    const existing = byUser.get(e.user_id);
    if (existing) existing.minutes += minutes;
    else byUser.set(e.user_id, { name, minutes });
  }
  return byUser;
}

// Rapport-Stunden: aggregiert time_ranges aller service_reports pro
// technician_id. Pause wird in Minuten abgezogen.
// Liefert getrennt:
//   billableByUser  — Ranges OHNE not_billable
//   notBillableByUser — Ranges MIT not_billable (gelbe Spalte in der Abrechnung)
//   notBillableReasonsByUser — gesammelte Gruende fuer Info-Tooltip
function aggregateReportPerUser(reports: ServiceReportData[]): {
  billable: Map<string, number>;
  notBillable: Map<string, number>;
  notBillableReasons: Map<string, string[]>;
} {
  const billable = new Map<string, number>();
  const notBillable = new Map<string, number>();
  const notBillableReasons = new Map<string, string[]>();
  for (const r of reports) {
    for (const tr of r.time_ranges ?? []) {
      if (!tr.technician_id || !tr.date || !tr.start || !tr.end) continue;
      const start = new Date(`${tr.date}T${tr.start}:00`);
      const end = new Date(`${tr.date}T${tr.end}:00`);
      const raw = Math.round((end.getTime() - start.getTime()) / 60000);
      const minutes = Math.max(0, raw - (tr.pause || 0));
      const target = tr.not_billable ? notBillable : billable;
      target.set(tr.technician_id, (target.get(tr.technician_id) ?? 0) + minutes);
      if (tr.not_billable && tr.not_billable_reason) {
        const arr = notBillableReasons.get(tr.technician_id) ?? [];
        arr.push(tr.not_billable_reason);
        notBillableReasons.set(tr.technician_id, arr);
      }
    }
  }
  return { billable, notBillable, notBillableReasons };
}

// =====================================================================
// Page
// =====================================================================

type ModalState =
  | { kind: "job"; job: UnbilledJob }
  | { kind: "job-skip"; job: UnbilledJob }
  | { kind: "beleg"; beleg: UnfiledBeleg }
  | { kind: "beleg-reject"; beleg: UnfiledBeleg }
  | null;

export default function AbrechnungPage() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { can, ready } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [jobs, setJobs] = useState<UnbilledJob[]>([]);
  // Bexio-Rechnungs-Vorschlaege (jobId -> Kandidaten) + Ladezustand.
  const [bexioVorschlaege, setBexioVorschlaege] = useState<Record<string, BexioInvoiceVorschlag[]>>({});
  const [bexioSucht, setBexioSucht] = useState(false);
  const [bexioBusyJobId, setBexioBusyJobId] = useState<string | null>(null);
  const [belege, setBelege] = useState<UnfiledBeleg[]>([]);
  // Pagination-State pro Stream: Gesamt-Count (head:true), hasMore
  // (+1-Trick) und Lade-Flag fuer den "Mehr laden"-Button.
  const [jobsTotal, setJobsTotal] = useState<number | null>(null);
  const [belegeTotal, setBelegeTotal] = useState<number | null>(null);
  const [jobsHasMore, setJobsHasMore] = useState(false);
  const [belegeHasMore, setBelegeHasMore] = useState(false);
  const [jobsLoadingMore, setJobsLoadingMore] = useState(false);
  const [belegeLoadingMore, setBelegeLoadingMore] = useState(false);
  const [namesById, setNamesById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Floating PDF/Image-Vorschau — non-modal.
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);
  // Highlight-jobId aus ?highlight=... (Bruecke Rapport -> Abrechnung).
  // Karte wird gescrollt + border-flash animiert.
  const highlightId = searchParams.get("highlight");
  const [flashJobId, setFlashJobId] = useState<string | null>(null);

  // Filter-Bausteine — MUESSEN in Daten- und Count-Query identisch sein,
  // sonst passt "X von Y" nicht zur Liste (gleiche Regel wie use-nav-counts).
  // is_deleted null-safe: alte Rows koennen NULL sein (Spalte wurde
  // mit default false nachtraeglich hinzugefuegt, aber nicht NOT NULL).
  // .neq("is_deleted", true) verwirft NULL-Rows, weil in SQL
  // `NULL != true` als NULL evaluiert → RLS-Filter faellt raus.
  const buildJobsQuery = useCallback((from: number) => {
    return supabase
      .from("jobs")
      .select(JOBS_SELECT)
      .eq("status", "abgeschlossen")
      .is("invoiced_at", null)
      .is("invoice_skipped_at", null)
      .or("is_deleted.is.null,is_deleted.eq.false")
      .order("end_date", { ascending: false, nullsFirst: false })
      // range ist beidseitig inklusiv → liefert PAGE_SIZE+1 Zeilen (+1-Trick).
      .range(from, from + PAGE_SIZE);
  }, [supabase]);

  const buildBelegeQuery = useCallback((from: number) => {
    return supabase
      .from("tickets")
      .select(BELEGE_SELECT)
      .eq("type", "beleg")
      .is("filed_at", null)
      .neq("status", "abgelehnt")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE_SIZE);
  }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);

    const [jobsRes, belegeRes, jobsCountRes, belegeCountRes, usersRes] = await Promise.all([
      buildJobsQuery(0),
      buildBelegeQuery(0),
      // head:true-Counts fuer das "X von Y"-Badge (Muster use-nav-counts).
      supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "abgeschlossen")
        .is("invoiced_at", null)
        .is("invoice_skipped_at", null)
        .or("is_deleted.is.null,is_deleted.eq.false"),
      supabase
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("type", "beleg")
        .is("filed_at", null)
        .neq("status", "abgelehnt"),
      // Namens-Lookup fuer Rapport-technician_ids die in den Stempel-
      // time_entries nicht vorkommen (z.B. wenn nur per Rapport erfasst).
      supabase.rpc("get_assignable_users"),
    ]);
    if (jobsRes.error) TOAST.supabaseError(jobsRes.error, "Aufträge konnten nicht geladen werden");
    if (belegeRes.error) TOAST.supabaseError(belegeRes.error, "Belege konnten nicht geladen werden");
    const jobRows = (jobsRes.data as unknown as UnbilledJob[]) ?? [];
    setJobsHasMore(jobRows.length > PAGE_SIZE);
    setJobs(jobRows.slice(0, PAGE_SIZE));
    const belegRows = (belegeRes.data as unknown as UnfiledBeleg[]) ?? [];
    setBelegeHasMore(belegRows.length > PAGE_SIZE);
    setBelege(belegRows.slice(0, PAGE_SIZE));
    setJobsTotal(jobsCountRes.count ?? null);
    setBelegeTotal(belegeCountRes.count ?? null);
    const nameMap = new Map<string, string>();
    for (const u of (usersRes.data as { id: string; full_name: string }[] | null) ?? []) {
      nameMap.set(u.id, u.full_name);
    }
    setNamesById(nameMap);

    setLoading(false);
  }, [supabase, buildJobsQuery, buildBelegeQuery]);

  // "Mehr laden" — range-basiert ab der aktuell geladenen Zeilenzahl.
  // Sortierung ist stabil (end_date bzw. created_at desc), daher reicht
  // ein Offset; der +1-Trick haelt hasMore aktuell.
  const loadMoreJobs = useCallback(async () => {
    if (jobsLoadingMore) return;
    setJobsLoadingMore(true);
    const { data, error } = await buildJobsQuery(jobs.length);
    if (error) TOAST.supabaseError(error, "Aufträge konnten nicht geladen werden");
    const rows = (data as unknown as UnbilledJob[]) ?? [];
    setJobsHasMore(rows.length > PAGE_SIZE);
    // Dedupe per id: hat sich die Liste serverseitig verschoben (anderer
    // User hat abgerechnet), kann der Offset eine schon geladene Row
    // wiederbringen — doppelte React-Keys vermeiden.
    setJobs((prev) => {
      const have = new Set(prev.map((j) => j.id));
      return [...prev, ...rows.slice(0, PAGE_SIZE).filter((j) => !have.has(j.id))];
    });
    setJobsLoadingMore(false);
  }, [buildJobsQuery, jobs.length, jobsLoadingMore]);

  const loadMoreBelege = useCallback(async () => {
    if (belegeLoadingMore) return;
    setBelegeLoadingMore(true);
    const { data, error } = await buildBelegeQuery(belege.length);
    if (error) TOAST.supabaseError(error, "Belege konnten nicht geladen werden");
    const rows = (data as unknown as UnfiledBeleg[]) ?? [];
    setBelegeHasMore(rows.length > PAGE_SIZE);
    setBelege((prev) => {
      const have = new Set(prev.map((b) => b.id));
      return [...prev, ...rows.slice(0, PAGE_SIZE).filter((b) => !have.has(b.id))];
    });
    setBelegeLoadingMore(false);
  }, [buildBelegeQuery, belege.length, belegeLoadingMore]);

  useEffect(() => { load(); }, [load]);

  // Highlight-Handler: sobald die Jobs geladen sind und ein highlight-Param
  // da ist, flash die Karte 2s und strippe den Param aus der URL (damit ein
  // Reload nicht immer wieder flasht). Der Scroll passiert nicht hier via
  // setTimeout+getElementById (das verpufft bei spaeten Rerendern), sondern
  // in JobCard selbst per Callback-Ref (§15 CLAUDE.md).
  useEffect(() => {
    if (!highlightId || loading) return;
    const exists = jobs.some((j) => j.id === highlightId);
    if (!exists) {
      // Job liegt nicht (mehr) in der Abrechnungs-Liste — z.B. schon
      // abgerechnet. Param trotzdem strippen.
      const params = new URLSearchParams(searchParams.toString());
      params.delete("highlight");
      const qs = params.toString();
      router.replace(`/abrechnung${qs ? `?${qs}` : ""}`, { scroll: false });
      return;
    }
    // setState defer'd via queueMicrotask, damit ESLint's
    // react-hooks/set-state-in-effect nicht ueber synchronen setState
    // im Effect meckert und React nicht cascading-rendert.
    queueMicrotask(() => setFlashJobId(highlightId));
    const flashTimer = setTimeout(() => setFlashJobId(null), 2100);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("highlight");
    const qs = params.toString();
    router.replace(`/abrechnung${qs ? `?${qs}` : ""}`, { scroll: false });
    return () => {
      clearTimeout(flashTimer);
    };
  }, [highlightId, loading, jobs, router, searchParams]);

  function openJobModal(job: UnbilledJob) {
    setModal({ kind: "job", job });
    setReference("");
  }

  function openJobSkipModal(job: UnbilledJob) {
    setModal({ kind: "job-skip", job });
    setReference("");
  }

  function openBelegModal(beleg: UnfiledBeleg) {
    setModal({ kind: "beleg", beleg });
    setReference("");
  }

  function openBelegRejectModal(beleg: UnfiledBeleg) {
    setModal({ kind: "beleg-reject", beleg });
    setReference("");
  }

  function closeModal() {
    if (submitting) return;
    setModal(null);
    setReference("");
  }

  async function submit() {
    if (!modal) return;
    const trimmed = reference.trim();

    // Validation pro Modal-Kind: Rechnung/Ablage brauchen 5-stellige Nr,
    // Reject + Job-Skip brauchen eine Begruendung (>= 1 Zeichen, max 500).
    if (modal.kind === "beleg-reject" || modal.kind === "job-skip") {
      if (!trimmed) {
        TOAST.requiredField("Begründung");
        return;
      }
      if (trimmed.length > 500) {
        TOAST.error("Begründung zu lang (max 500 Zeichen)");
        return;
      }
    } else if (!trimmed) {
      TOAST.requiredField(modal.kind === "job" ? "Rechnungsnummer" : "Ablage-Referenz");
      return;
    }

    // Zweite Bestaetigung — Aktion ist via UI nicht mehr rueckgaengig
    // zu machen, daher das zweite Gate.
    let confirmTitle: string;
    let confirmMessage: string;
    let variant: "red" | "blue" = "blue";
    if (modal.kind === "job") {
      confirmTitle = `Rechnung Nr. ${trimmed} bestätigen?`;
      confirmMessage = `Der Auftrag ${formatJobNumber(modal.job.job_number)} wird als abgerechnet markiert. Die Nummer kann nur über die Datenbank geändert werden.`;
    } else if (modal.kind === "job-skip") {
      confirmTitle = `${formatJobNumber(modal.job.job_number)} ohne Rechnung schliessen?`;
      confirmMessage = `Der Auftrag wird aus der Abrechnungs-Liste entfernt. Die Begründung bleibt im Job-Detail nachvollziehbar.`;
      variant = "red";
    } else if (modal.kind === "beleg") {
      confirmTitle = `Beleg-Referenz Nr. ${trimmed} bestätigen?`;
      confirmMessage = `Das Beleg-Ticket ${formatTicketNumber(modal.beleg.ticket_number)} wird als abgelegt markiert (Status: erledigt). Die Nummer kann nur über die Datenbank geändert werden.`;
    } else {
      confirmTitle = `Beleg ${formatTicketNumber(modal.beleg.ticket_number)} ablehnen?`;
      confirmMessage = `Der Mitarbeiter sieht die Begründung im Ticket-Detail. Status wird auf "abgelehnt" gesetzt.`;
      variant = "red";
    }
    const isReject = modal.kind === "beleg-reject" || modal.kind === "job-skip";
    const ok = await confirm({
      title: confirmTitle,
      message: confirmMessage,
      confirmLabel: isReject ? "Definitiv markieren" : "Definitiv bestätigen",
      cancelLabel: "Zurück",
      variant,
    });
    if (!ok) return;

    setSubmitting(true);
    let url: string;
    let body: Record<string, string>;
    if (modal.kind === "job") {
      url = `/api/jobs/${modal.job.id}/mark-invoiced`;
      body = { invoice_number: trimmed };
    } else if (modal.kind === "job-skip") {
      url = `/api/jobs/${modal.job.id}/mark-invoice-skipped`;
      body = { reason: trimmed };
    } else if (modal.kind === "beleg") {
      url = `/api/tickets/${modal.beleg.id}/mark-filed`;
      body = { filed_reference: trimmed };
    } else {
      url = `/api/tickets/${modal.beleg.id}/reject-beleg`;
      body = { reason: trimmed };
    }
    // Netzwerk-/JSON-Fehler MUESSEN das submitting-Flag freigeben, sonst
    // bleibt der Modal-Button dauerhaft „Speichere…" und der User haengt.
    // WICHTIG: submitting bleibt bis zum setModal(null) TRUE — sonst kann
    // der User im Zeitfenster zwischen fetch-Success und Modal-Close den
    // Button erneut klicken (Doppel-Submit-Race).
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !json?.success) {
        TOAST.errorOr(json?.error, "Aktion fehlgeschlagen");
        setSubmitting(false);
        return;
      }
    } catch (err) {
      TOAST.errorOr(err instanceof Error ? err.message : null, "Netzwerkfehler");
      setSubmitting(false);
      return;
    }
    if (modal.kind === "job") {
      // Undo-Toast (5s): der User kann die Aktion sofort rueckgaengig machen
      // wenn er versehentlich klickte oder die Nummer falsch tippte. Nach
      // Ablauf ist der Auftrag endgueltig abgerechnet in der Liste.
      const undoJob = modal.job;
      const undoTrimmed = trimmed;
      toast.success(`${formatJobNumber(undoJob.job_number)} als Rechnung ${undoTrimmed} abgerechnet`, {
        action: {
          label: "Rückgängig",
          onClick: async () => {
            const res = await fetch(`/api/jobs/${undoJob.id}/undo-mark-invoiced`, { method: "POST" });
            const json = await res.json().catch(() => null);
            if (!json?.success) {
              TOAST.errorOr(json?.error, "Rückgängig fehlgeschlagen");
              return;
            }
            toast.success(`${formatJobNumber(undoJob.job_number)} zurück in der Abrechnungs-Liste`);
            load();
          },
        },
        duration: 5000,
      });
      setJobs((prev) => prev.filter((j) => j.id !== modal.job.id));
      setJobsTotal((t) => (t === null ? t : Math.max(0, t - 1)));
    } else if (modal.kind === "job-skip") {
      toast.success(`${formatJobNumber(modal.job.job_number)} ohne Rechnung geschlossen`);
      setJobs((prev) => prev.filter((j) => j.id !== modal.job.id));
      setJobsTotal((t) => (t === null ? t : Math.max(0, t - 1)));
    } else if (modal.kind === "beleg") {
      toast.success(`Beleg ${formatTicketNumber(modal.beleg.ticket_number)} abgelegt (${trimmed})`);
      setBelege((prev) => prev.filter((b) => b.id !== modal.beleg.id));
      setBelegeTotal((t) => (t === null ? t : Math.max(0, t - 1)));
    } else {
      toast.success(`Beleg ${formatTicketNumber(modal.beleg.ticket_number)} abgelehnt`);
      setBelege((prev) => prev.filter((b) => b.id !== modal.beleg.id));
      setBelegeTotal((t) => (t === null ? t : Math.max(0, t - 1)));
    }
    setModal(null);
    setReference("");
    setSubmitting(false);
  }

  const canEdit = useMemo(() => can("abrechnung:edit"), [can]);

  // Bexio-Vorschlaege im Hintergrund laden (einmal pro Mount, nach den
  // Karten). Fehler lassen die Abrechnung unangetastet — nur kein Banner.
  const bexioGeladenRef = useRef(false);
  useEffect(() => {
    if (loading || !canEdit || bexioGeladenRef.current) return;
    bexioGeladenRef.current = true;
    (async () => {
      setBexioSucht(true);
      try {
        const res = await fetch("/api/bexio/invoices/vorschlaege", { method: "POST" });
        const json = await res.json().catch(() => null);
        if (json?.success && json.connected) setBexioVorschlaege(json.vorschlaege ?? {});
      } catch {
        // Hintergrund-Check — still.
      } finally {
        setBexioSucht(false);
      }
    })();
  }, [loading, canEdit]);

  async function bexioUebernehmen(job: UnbilledJob, v: BexioInvoiceVorschlag) {
    const ok = await confirm({
      title: `Rechnung ${v.nr} für ${formatJobNumber(job.job_number)} übernehmen?`,
      message: `Die Rechnungsnummer wird eingetragen, der Auftrag als abgerechnet markiert und das Rechnungs-PDF aus Bexio in die Auftrags-Dokumente gelegt (CHF ${v.total.toFixed(2)}, ${formatDate(v.datum)}).`,
      confirmLabel: "Definitiv bestätigen",
      cancelLabel: "Zurück",
    });
    if (!ok) return;
    setBexioBusyJobId(job.id);
    try {
      const res = await fetch("/api/bexio/invoices/uebernehmen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, invoiceId: v.invoiceId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        TOAST.errorOr(json?.error, "Übernahme fehlgeschlagen");
        return;
      }
      toast.success(
        json.pdfUebernommen
          ? `${formatJobNumber(job.job_number)} als Rechnung ${json.invoiceNumber} abgerechnet — PDF liegt in den Dokumenten`
          : `${formatJobNumber(job.job_number)} als Rechnung ${json.invoiceNumber} abgerechnet — PDF konnte nicht geladen werden, bitte manuell hochladen`,
        { duration: 7000 },
      );
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      setJobsTotal((t) => (t === null ? t : Math.max(0, t - 1)));
      setBexioVorschlaege((prev) => {
        const kopie = { ...prev };
        delete kopie[job.id];
        return kopie;
      });
    } catch (err) {
      TOAST.errorOr(err instanceof Error ? err.message : null, "Netzwerkfehler");
    } finally {
      setBexioBusyJobId(null);
    }
  }

  if (!ready) {
    // Skeleton-Fallback statt leerer Seite waehrend Permissions laden (§7).
    // Struktur spiegelt das echte Layout: Header + zwei Spalten mit Karten.
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[0, 1].map((col) => (
            <div key={col} className="space-y-3">
              <Skeleton className="h-6 w-40" />
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const modalKind = modal?.kind ?? null;
  const isJobModal = modalKind === "job";
  const isJobSkip = modalKind === "job-skip";
  const isBelegFile = modalKind === "beleg";
  const isBelegReject = modalKind === "beleg-reject";
  // Felder mit freier Begruendung (Textarea statt Ziffern-Input).
  const isTextarea = isJobSkip || isBelegReject;

  const modalTitle = !modal
    ? ""
    : modal.kind === "job"
      ? `Rechnung gestellt für ${formatJobNumber(modal.job.job_number)}`
      : modal.kind === "job-skip"
        ? `Keine Rechnung für ${formatJobNumber(modal.job.job_number)}`
        : modal.kind === "beleg"
          ? `Beleg abgelegt — ${formatTicketNumber(modal.beleg.ticket_number)}`
          : `Beleg ablehnen — ${formatTicketNumber(modal.beleg.ticket_number)}`;
  const modalIcon = isJobModal
    ? <Receipt className="h-5 w-5 text-blue-500" />
    : isJobSkip
      ? <Ban className="h-5 w-5 text-red-500" />
      : isBelegFile
        ? <FolderArchive className="h-5 w-5 text-blue-500" />
        : <XCircle className="h-5 w-5 text-red-500" />;
  const fieldLabel = isJobModal
    ? "Rechnungsnummer"
    : isJobSkip
      ? "Begründung warum keine Rechnung gestellt wird"
      : isBelegFile
        ? "Ablage-Referenz"
        : "Begründung für Ablehnung";
  const fieldHint = isJobModal
    ? `Rechnungsnummer aus Bexio o.ä.`
    : isJobSkip
      ? `z.B. Garantie, Kulanz, intern, Doppel-Erfassung. Bleibt im Job-Detail nachvollziehbar.`
      : isBelegFile
        ? `Bexio-Beleg-Nummer oder andere Ablage-Referenz.`
        : `Wird dem Mitarbeiter im Ticket-Detail angezeigt.`;

  // BackButton konditional: nur wenn User via Dashboard-Link (?from=dashboard)
  // hierhergekommen ist. Sidebar-Navigation braucht keinen Zurueck-Pfeil.
  const fromDashboard = searchParams.get("from") === "dashboard";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 min-w-0">
        {fromDashboard && <BackButton fallbackHref="/dashboard" />}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Abrechnung</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Aufträge mit gestellter Rechnung und Belege als abgelegt markieren.
          </p>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-y-6 lg:gap-y-0">
          {/* Linke Spalte — Auftraege. lg:border-r + Padding macht den
              Trennstrich in der Mitte; auf Mobile (stacked) kein Border. */}
          <div className="space-y-3 lg:pr-6 lg:border-r lg:border-border">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Aufträge
              </h2>
              {bexioSucht && (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Suche Bexio-Rechnungen…
                </span>
              )}
              {jobs.length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {/* "X von Y": Y aus der head:true-Count-Query — zeigt ehrlich,
                      wieviel insgesamt offen ist, auch wenn erst eine Seite
                      geladen wurde. */}
                  {jobsTotal !== null && jobsTotal > jobs.length
                    ? `${jobs.length} von ${jobsTotal} offen`
                    : `${jobs.length} offen`}
                </span>
              )}
            </div>
            {jobs.length === 0 ? (
              <EmptyState message="Alles abgerechnet." sub="Sobald ein Auftrag abgeschlossen wird, taucht er hier auf." />
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onMarkBilled={() => openJobModal(job)}
                    onSkip={() => openJobSkipModal(job)}
                    canEdit={canEdit}
                    onPreview={setPreviewDoc}
                    namesById={namesById}
                    flash={flashJobId === job.id}
                    bexio={bexioVorschlaege[job.id]}
                    bexioBusy={bexioBusyJobId === job.id}
                    onBexioUebernehmen={(v) => bexioUebernehmen(job, v)}
                  />
                ))}
                {jobsHasMore && (
                  <button
                    type="button"
                    onClick={loadMoreJobs}
                    disabled={jobsLoadingMore}
                    className="kasten kasten-muted w-full"
                  >
                    {jobsLoadingMore
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <ChevronDown className="h-3.5 w-3.5" />}
                    {jobsLoadingMore ? "Lade…" : "Mehr laden"}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Rechte Spalte — Belege */}
          <div className="space-y-3 lg:pl-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Belege
              </h2>
              {belege.length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {belegeTotal !== null && belegeTotal > belege.length
                    ? `${belege.length} von ${belegeTotal} offen`
                    : `${belege.length} offen`}
                </span>
              )}
            </div>
            {belege.length === 0 ? (
              <EmptyState message="Alles abgelegt." sub="Sobald ein Beleg-Ticket erfasst wird, taucht es hier auf." />
            ) : (
              <div className="space-y-3">
                {belege.map((beleg) => (
                  <BelegCard
                    key={beleg.id}
                    beleg={beleg}
                    onMarkFiled={() => openBelegModal(beleg)}
                    onReject={() => openBelegRejectModal(beleg)}
                    canEdit={canEdit}
                  />
                ))}
                {belegeHasMore && (
                  <button
                    type="button"
                    onClick={loadMoreBelege}
                    disabled={belegeLoadingMore}
                    className="kasten kasten-muted w-full"
                  >
                    {belegeLoadingMore
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <ChevronDown className="h-3.5 w-3.5" />}
                    {belegeLoadingMore ? "Lade…" : "Mehr laden"}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal
        open={modal !== null}
        onClose={closeModal}
        title={modalTitle}
        icon={modalIcon}
        size="md"
        closable={!submitting}
      >
        <div>
          <label className="text-sm font-medium">{fieldLabel}</label>
          <p className="text-xs text-muted-foreground mt-0.5 mb-2">{fieldHint}</p>
          {isTextarea ? (
            // Reject + Job-Skip brauchen Textarea fuer die Begruendung.
            <textarea
              value={reference}
              onChange={(e) => setReference(e.target.value.slice(0, 500))}
              placeholder={
                isJobSkip
                  ? "z.B. Garantie, Kulanz, intern, Doppel-Erfassung..."
                  : "z.B. fehlender Beleg, falscher Betrag, nicht genehmigt..."
              }
              autoFocus
              rows={3}
              maxLength={500}
              className="w-full px-3 py-2 text-sm rounded-lg border border-input bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          ) : (
            <Input
              value={reference}
              // Number-Input fuer Rechnungs-/Ablage-Nr: nur Ziffern, max 5 Stellen.
              onChange={(e) => setReference(e.target.value.replace(/\D/g, "").slice(0, 5))}
              placeholder="00000"
              autoFocus
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={5}
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          )}
        </div>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={closeModal}
            disabled={submitting}
            className="kasten kasten-muted flex-1"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !reference.trim()}
            className={`flex-1 ${isTextarea ? "kasten kasten-red" : "kasten kasten-green"}`}
          >
            {isJobModal ? (
              <Receipt className="h-3.5 w-3.5" />
            ) : isJobSkip ? (
              <Ban className="h-3.5 w-3.5" />
            ) : isBelegFile ? (
              <FolderArchive className="h-3.5 w-3.5" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            {submitting ? "Speichere…" : isBelegReject ? "Ablehnen" : isJobSkip ? "Ohne Rechnung schliessen" : "Bestätigen"}
          </button>
        </div>
      </Modal>
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



// =====================================================================
// EmptyState — pro Spalte
// =====================================================================

function EmptyState({ message, sub }: { message: string; sub: string }) {
  return (
    <Card className="bg-card">
      <CardContent className="p-8 text-center">
        <CheckCircle2 className="h-8 w-8 mx-auto text-green-500 mb-2" />
        <p className="font-medium text-sm">{message}</p>
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      </CardContent>
    </Card>
  );
}

// =====================================================================
// Shared sub-components — fuer Konsistenz zwischen Job- und Beleg-Card.
// =====================================================================

/** Identifier-Badge: subtle outlined pill mit "PREFIX-NUMMER". Identische
 *  Optik fuer INT-X (Auftraege) und T-X (Tickets), damit beide Cards
 *  visuell zur selben Familie gehoeren. */
function IdentifierBadge({ prefix, number }: { prefix: string; number: number | string | null | undefined }) {
  return (
    <span className="inline-flex items-center font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded bg-foreground/[0.04] dark:bg-foreground/[0.10] shrink-0">
      {prefix}-{number ?? "?"}
    </span>
  );
}

/** Meta-Zeile mit Pipe-Separator — bewusst ohne Icons damit's ruhig wirkt.
 *  Pattern matched die Sub-Line auf /auftraege. Null/undefined Items werden
 *  rausgefiltert, sodass Caller einfach durchschicken kann. */
function MetaLine({ items, primary }: { items: (string | null | undefined)[]; primary?: string | null }) {
  const filtered = items.filter((s): s is string => Boolean(s && s.trim()));
  if (!primary && filtered.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5 min-w-0 flex-wrap">
      {primary && (
        <>
          <span className="font-mono font-semibold text-foreground shrink-0">{primary}</span>
          {filtered.length > 0 && <span className="opacity-50 shrink-0">|</span>}
        </>
      )}
      {filtered.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5 min-w-0">
          {i > 0 && <span className="opacity-50 shrink-0">|</span>}
          <span className="truncate">{item}</span>
        </span>
      ))}
    </div>
  );
}

/** Section-Label fuer Body-Inhalte (Arbeitsrapport, Stunden, Beschreibung). */
function SectionLabel({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
      <Icon className="h-3 w-3" />
      {children}
    </h4>
  );
}

// =====================================================================
// JobCard
// =====================================================================

/** Bexio-Rechnungs-Vorschlag (aus /api/bexio/invoices/vorschlaege). */
export interface BexioInvoiceVorschlag {
  invoiceId: number;
  nr: string;
  titel: string | null;
  total: number;
  datum: string;
  matchArt: "auftrag" | "kunde";
}

interface JobCardProps {
  job: UnbilledJob;
  onMarkBilled: () => void;
  onSkip: () => void;
  canEdit: boolean;
  onPreview: (doc: { url: string; title: string }) => void;
  namesById: Map<string, string>;
  /** Highlight-Flash nach Ankunft aus /auftraege/[id] via ?highlight=... */
  flash: boolean;
  /** In Bexio gefundene Rechnungen, die zu diesem Auftrag passen. */
  bexio?: BexioInvoiceVorschlag[];
  bexioBusy?: boolean;
  onBexioUebernehmen?: (v: BexioInvoiceVorschlag) => void;
}

function JobCard({ job, onMarkBilled, onSkip, canEdit, onPreview, namesById, flash, bexio, bexioBusy, onBexioUebernehmen }: JobCardProps) {
  // Scroll-into-view via Callback-Ref (§15 CLAUDE.md): feuert exakt einmal
  // wenn flash zum ersten Mal true wird UND der DOM-Node steht. useCallback
  // ist auf flash dependency-gated — sobald flash false→true wechselt, hat
  // die Ref-Callback eine neue Identity, React ruft sie mit dem echten Node
  // auf. hasScrolledRef schuetzt vor Re-Scroll auf Rerender-Cascades.
  const hasScrolledRef = useRef(false);
  const cardRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !flash) return;
      if (hasScrolledRef.current) return;
      hasScrolledRef.current = true;
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    [flash],
  );
  const report = job.service_reports[0] ?? null;
  const stempelByUser = aggregatePerUser(job.time_entries);
  const { billable: rapportByUser, notBillable: notBillableByUser, notBillableReasons } = aggregateReportPerUser(job.service_reports);
  // Union aus Stempel + Rapport (verrechenbar + nicht-verrechenbar), sortiert
  // nach Stempel-Stunden absteigend, dann Rapport-Stunden.
  const userIds = Array.from(new Set([...stempelByUser.keys(), ...rapportByUser.keys(), ...notBillableByUser.keys()]));
  const perUser = userIds.map((id) => ({
    userId: id,
    name: stempelByUser.get(id)?.name ?? namesById.get(id) ?? "Unbekannt",
    stempel: stempelByUser.get(id)?.minutes ?? 0,
    rapport: rapportByUser.get(id) ?? 0,
    notBillable: notBillableByUser.get(id) ?? 0,
    notBillableReasons: notBillableReasons.get(id) ?? [],
  })).sort((a, b) => (b.stempel - a.stempel) || (b.rapport - a.rapport));
  const totalStempel = perUser.reduce((sum, p) => sum + p.stempel, 0);
  const totalRapport = perUser.reduce((sum, p) => sum + p.rapport, 0);
  const totalNotBillable = perUser.reduce((sum, p) => sum + p.notBillable, 0);
  const hasNotBillable = totalNotBillable > 0;
  const dateRange = job.start_date && job.end_date && job.start_date !== job.end_date
    ? `${formatDate(job.start_date)} – ${formatDate(job.end_date)}`
    : formatDate(job.end_date ?? job.start_date);

  return (
    <Card
      ref={cardRef}
      className="bg-card overflow-hidden transition-shadow"
      // Highlight-Flash bei Ankunft aus dem Auftrag-Detail. Robust per
      // inline style — Tailwind-`ring-*`-Utilities greifen an Card manchmal
      // unzuverlaessig (siehe CLAUDE.md §3 zu Hover/State-driven).
      style={
        flash
          ? {
              boxShadow: "0 0 0 3px rgb(59 130 246 / 0.55), 0 8px 24px -8px rgb(59 130 246 / 0.35)",
              transition: "box-shadow 0.6s ease-out",
            }
          : undefined
      }
    >
      {/* Header — items-center vertikal-zentriert den Button mit dem Text-Block,
          unabhaengig von Title-/Meta-Zeilenanzahl. */}
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <IdentifierBadge prefix={ENTITY_PREFIX.job} number={job.job_number} />
          </div>
          <h3 className="font-semibold text-sm truncate">
            <Link href={`/auftraege/${job.id}`} className="hover:underline">{job.title}</Link>
          </h3>
          <MetaLine items={[job.customer?.name, dateRange, job.location?.name]} />
        </div>
        {canEdit && (
          // Visuelle Grammatik: "Rechnung gestellt" ist die einzige positive
          // Aktion (Rechnungen werden manuell in Bexio erstellt und hier nur
          // als abgerechnet markiert). Skip liegt im Overflow-Menu damit die
          // Karte visuell ruhig bleibt.
          <JobCardActions
            onSkip={onSkip}
            onMarkBilled={onMarkBilled}
          />
        )}
      </div>

      {/* Bexio-Rechnungs-Vorschlag: in Bexio wurde bereits eine passende
          Rechnung gestellt — ein Klick uebernimmt Nummer + PDF. */}
      {canEdit && (bexio?.length ?? 0) > 0 && (
        <div className="border-t border-blue-200/60 dark:border-blue-500/25 bg-blue-50/60 dark:bg-blue-500/10 px-4 py-2 space-y-1.5">
          {bexio!.map((v) => (
            <div key={v.invoiceId} className="flex items-center gap-2 flex-wrap">
              <Receipt className="h-3.5 w-3.5 text-blue-700 dark:text-blue-300 shrink-0" />
              <p className="text-xs text-blue-900 dark:text-blue-100 flex-1 min-w-0">
                Bexio-Rechnung <strong>{v.nr}</strong> · CHF {v.total.toFixed(2)} · {formatDate(v.datum)}
                {v.matchArt === "kunde" && (
                  <span className="text-blue-700/70 dark:text-blue-300/70"> · gleicher Kunde{v.titel ? ` («${v.titel}»)` : ""} — bitte prüfen</span>
                )}
              </p>
              <button
                type="button"
                onClick={() => onBexioUebernehmen?.(v)}
                disabled={bexioBusy}
                className="kasten kasten-bexio shrink-0"
                data-tooltip="Rechnungsnummer eintragen + PDF in die Auftrags-Dokumente"
              >
                {bexioBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Receipt className="h-3.5 w-3.5" />}
                Übernehmen
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Body — getrennt durch dezente Border-Linie */}
      <div className="border-t px-4 py-3 space-y-3">
        <div>
          <div className="flex items-center justify-between gap-2">
            <SectionLabel icon={FileText}>Arbeitsrapport</SectionLabel>
            {report && (
              <button
                type="button"
                onClick={async () => {
                  // Bevorzugt Storage-PDF (schneller, kein API-Roundtrip);
                  // fallback: on-the-fly ueber /api/reports/[id]/pdf — greift
                  // wenn pdf_url NULL ist (z.B. nach Rapport-Verschiebung, oder
                  // "altem Bestand vor 6.5.2026" wo nie eins persistiert wurde).
                  if (report.pdf_url) {
                    const supabase = createClient();
                    const { data, error } = await supabase.storage.from("documents").createSignedUrl(report.pdf_url, 3600);
                    if (!error && data?.signedUrl) {
                      onPreview({ url: data.signedUrl, title: `Rapport ${formatJobNumber(job.job_number)}` });
                      return;
                    }
                    // Signed-URL-Fehler -> fallback auf On-the-fly-Endpoint.
                  }
                  onPreview({ url: `/api/reports/${report.id}/pdf`, title: `Rapport ${formatJobNumber(job.job_number)}` });
                }}
                className="kasten kasten-blue"
                data-tooltip="Rapport-PDF Vorschau"
              >
                <Eye className="h-3.5 w-3.5" />
                Rapport-PDF
              </button>
            )}
          </div>
          {report ? (
            <div className="space-y-1.5 text-sm">
              <p className="whitespace-pre-wrap text-foreground">{report.work_description}</p>
              {report.equipment_used && (
                <p className="text-xs">
                  <span className="font-semibold text-muted-foreground">Material: </span>
                  <span className="whitespace-pre-wrap">{report.equipment_used}</span>
                </p>
              )}
              {report.issues && (
                <p className="text-xs">
                  <span className="font-semibold text-muted-foreground">Probleme: </span>
                  <span className="whitespace-pre-wrap">{report.issues}</span>
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">Kein Rapport erfasst.</p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <SectionLabel icon={Clock}>Stunden</SectionLabel>
            {perUser.length > 0 && (
              <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <span className="w-14 text-right">Stempel</span>
                <span className="w-14 text-right">Rapport</span>
                {hasNotBillable && (
                  <span className="w-24 text-right text-yellow-700 dark:text-yellow-400">Nicht verr.</span>
                )}
              </div>
            )}
          </div>
          {perUser.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Keine Stempelzeiten oder Rapport-Stunden erfasst.</p>
          ) : (
            <div className="text-xs space-y-0.5">
              {perUser.map((p) => (
                <div key={p.userId}>
                  <div className="flex items-center justify-between gap-2 py-0.5">
                    <span className="text-muted-foreground truncate min-w-0 flex-1">{p.name}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-mono tabular-nums w-14 text-right">
                        {p.stempel > 0 ? formatHours(p.stempel) : <span className="text-muted-foreground/50">—</span>}
                      </span>
                      <span className="font-mono tabular-nums w-14 text-right">
                        {p.rapport > 0 ? formatHours(p.rapport) : <span className="text-muted-foreground/50">—</span>}
                      </span>
                      {hasNotBillable && (
                        <span className="w-24 flex justify-end">
                          {p.notBillable > 0 ? (
                            <span className="inline-flex items-center justify-between gap-1.5 px-2 py-0.5 rounded bg-yellow-100 text-yellow-900 dark:bg-yellow-500/20 dark:text-yellow-200 min-w-full">
                              <Info className="h-3 w-3 shrink-0 opacity-70" />
                              <span className="font-mono tabular-nums">{formatHours(p.notBillable)}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Gruende als Sub-Zeile direkt unter dem Mitarbeiter — kein
                      Tooltip-Clipping mehr, immer voll lesbar. */}
                  {p.notBillableReasons.length > 0 && (
                    <div className="text-[10px] text-yellow-700 dark:text-yellow-400/90 italic pl-3 pb-1 leading-snug">
                      <span className="not-italic font-semibold">Grund: </span>
                      {p.notBillableReasons.join(" · ")}
                    </div>
                  )}
                </div>
              ))}
              {/* Total-Zeile als Summen-Footer */}
              <div className="flex items-center justify-between gap-2 mt-1.5 pt-1.5 border-t font-semibold text-sm">
                <span>Total</span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-mono tabular-nums w-14 text-right">
                    {totalStempel > 0 ? formatHours(totalStempel) : <span className="text-muted-foreground/50">—</span>}
                  </span>
                  <span className="font-mono tabular-nums w-14 text-right">
                    {totalRapport > 0 ? formatHours(totalRapport) : <span className="text-muted-foreground/50">—</span>}
                  </span>
                  {hasNotBillable && (
                    <span className="w-24 flex justify-end">
                      <span className="inline-flex items-center justify-between gap-1.5 px-2 py-0.5 rounded bg-yellow-100 text-yellow-900 dark:bg-yellow-500/20 dark:text-yellow-200 min-w-full">
                        <Info className="h-3 w-3 shrink-0 opacity-70" />
                        <span className="font-mono tabular-nums">{formatHours(totalNotBillable)}</span>
                      </span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** JobCardActions — Rechte Header-Aktionen der JobCard.
 *  Primaer: "Rechnung gestellt" — Rechnungen werden manuell in Bexio erstellt,
 *  hier nur als abgerechnet markiert (Nummer aus Bexio zurueckschreiben).
 *  Destruktiv/negativ: "Keine Rechnung stellen" im Overflow-Menu. */
function JobCardActions({
  onSkip,
  onMarkBilled,
}: {
  onSkip: () => void;
  onMarkBilled: () => void;
}) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!overflowOpen) return;
    function onOutside(e: MouseEvent) {
      if (!overflowRef.current) return;
      if (!overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOverflowOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [overflowOpen]);
  return (
    <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
      <button
        type="button"
        onClick={onMarkBilled}
        className="kasten kasten-green"
        data-tooltip="Rechnung in Bexio erstellt — hier Nummer hinterlegen"
      >
        <Receipt className="h-3.5 w-3.5" />
        Rechnung gestellt
      </button>
      <div className="relative" ref={overflowRef}>
        <button
          type="button"
          onClick={() => setOverflowOpen(!overflowOpen)}
          className={`kasten ${overflowOpen ? "kasten-active" : "kasten-muted"}`}
          data-tooltip="Weitere Aktionen"
          data-tooltip-align="end"
          aria-expanded={overflowOpen}
          aria-haspopup="menu"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
        {overflowOpen && (
          <div
            role="menu"
            className="absolute right-0 top-[calc(100%+6px)] z-40 min-w-[220px] rounded-xl border border-border bg-card shadow-lg p-1"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOverflowOpen(false);
                onSkip();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Ban className="h-4 w-4" />
              Keine Rechnung stellen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// BelegCard
// =====================================================================

interface BelegCardProps {
  beleg: UnfiledBeleg;
  onMarkFiled: () => void;
  onReject: () => void;
  canEdit: boolean;
}

function BelegCard({ beleg, onMarkFiled, onReject, canEdit }: BelegCardProps) {
  const d = beleg.data;
  const betragText = d.betrag_chf != null ? `CHF ${d.betrag_chf.toFixed(2)}` : null;

  return (
    <Card className="bg-card overflow-hidden">
      {/* Header — selbe Struktur wie JobCard fuer visuelle Konsistenz. */}
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <IdentifierBadge prefix={ENTITY_PREFIX.ticket} number={beleg.ticket_number} />
            {beleg.status === "offen" && (
              <span className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300">
                Offen
              </span>
            )}
            {beleg.status === "erledigt" && (
              <span className="inline-flex px-1.5 py-0 text-[10px] font-medium rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">
                Genehmigt
              </span>
            )}
          </div>
          <h3 className="font-semibold text-sm truncate">
            <Link href={`/tickets/${beleg.id}`} className="hover:underline">{beleg.title}</Link>
          </h3>
          {/* primary=Betrag (das wichtigste Feld auf einem Beleg). */}
          <MetaLine
            primary={betragText}
            items={[
              d.kaufdatum ? formatDate(d.kaufdatum) : null,
              d.lieferant,
              beleg.creator?.full_name,
            ]}
          />
        </div>
        {canEdit && (
          <div className="flex gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onReject}
              className="kasten kasten-red"
              data-tooltip="Beleg ablehnen"
              aria-label="Beleg ablehnen"
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={onMarkFiled} className="kasten kasten-green">
              <FolderArchive className="h-3.5 w-3.5" />
              Beleg abgelegt
            </button>
          </div>
        )}
      </div>

      {beleg.description && (
        <div className="border-t px-4 py-3">
          <SectionLabel icon={FileText}>Beschreibung</SectionLabel>
          <p className="text-sm whitespace-pre-wrap">{beleg.description}</p>
        </div>
      )}
    </Card>
  );
}
