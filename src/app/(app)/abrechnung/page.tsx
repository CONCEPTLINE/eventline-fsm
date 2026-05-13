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

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Receipt, FileText, Clock, CheckCircle2, FolderArchive, XCircle, Eye } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import { useConfirm } from "@/components/ui/use-confirm";
import Link from "next/link";
import type { TicketDataBeleg } from "@/types";
import { PdfPopup } from "@/components/pdf-popup";

// =====================================================================
// Auftrags-Stream (links)
// =====================================================================

interface TimeRange {
  date: string;
  start: string;
  end: string;
  pause: number;
  technician_id: string;
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
  id, job_number, title, start_date, end_date,
  customer:customers(name),
  location:locations(name),
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

// =====================================================================
// Umsatz-Trend (Stunden pro Monat, gruppiert nach invoiced_at)
// =====================================================================

interface TrendMonth {
  key: string;     // "2026-05" — fuer State-Keys
  label: string;   // "Mai" — fuer X-Achse
  hours: number;
  isCurrent: boolean;
}

const MONTH_LABELS_DE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

// =====================================================================
// Helpers
// =====================================================================

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const datePart = iso.split("T")[0];
  const [y, m, d] = datePart.split("-").map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" });
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
function aggregateReportPerUser(reports: ServiceReportData[]): Map<string, number> {
  const byUser = new Map<string, number>();
  for (const r of reports) {
    for (const tr of r.time_ranges ?? []) {
      if (!tr.technician_id || !tr.date || !tr.start || !tr.end) continue;
      const start = new Date(`${tr.date}T${tr.start}:00`);
      const end = new Date(`${tr.date}T${tr.end}:00`);
      const raw = Math.round((end.getTime() - start.getTime()) / 60000);
      const minutes = Math.max(0, raw - (tr.pause || 0));
      byUser.set(tr.technician_id, (byUser.get(tr.technician_id) ?? 0) + minutes);
    }
  }
  return byUser;
}

// =====================================================================
// Page
// =====================================================================

type ModalState =
  | { kind: "job"; job: UnbilledJob }
  | { kind: "beleg"; beleg: UnfiledBeleg }
  | { kind: "beleg-reject"; beleg: UnfiledBeleg }
  | null;

export default function AbrechnungPage() {
  const supabase = createClient();
  const { can, ready } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [jobs, setJobs] = useState<UnbilledJob[]>([]);
  const [belege, setBelege] = useState<UnfiledBeleg[]>([]);
  const [trend, setTrend] = useState<TrendMonth[]>([]);
  const [namesById, setNamesById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Floating PDF/Image-Vorschau — non-modal.
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    // Sechs-Monats-Fenster (aktueller + 5 vorhergehende). 1. des Monats
    // damit wir den ganzen Start-Monat einfangen.
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1, 0, 0, 0, 0);

    const [jobsRes, belegeRes, trendRes, usersRes] = await Promise.all([
      supabase
        .from("jobs")
        .select(JOBS_SELECT)
        .eq("status", "abgeschlossen")
        .is("invoiced_at", null)
        .neq("is_deleted", true)
        .order("end_date", { ascending: false, nullsFirst: false })
        .limit(100),
      supabase
        .from("tickets")
        .select(BELEGE_SELECT)
        .eq("type", "beleg")
        .is("filed_at", null)
        .neq("status", "abgelehnt")
        .order("created_at", { ascending: false })
        .limit(100),
      // Trend: nur Jobs die in den letzten 6 Monaten ABGERECHNET wurden
      // (= invoiced_at gefuellt). Stunden-Berechnung aus den verknuepften
      // time_entries. Wenn ein Job spaet abgerechnet wird (Stunden lange
      // davor gestempelt), zaehlt die Rechnung im Abrechnungs-Monat —
      // genau das was Buchhaltung sehen will (Umsatz-Realisierung).
      supabase
        .from("jobs")
        .select("invoiced_at, time_entries(clock_in, clock_out)")
        .not("invoiced_at", "is", null)
        .gte("invoiced_at", sixMonthsAgo.toISOString())
        .neq("is_deleted", true),
      // Namens-Lookup fuer Rapport-technician_ids die in den Stempel-
      // time_entries nicht vorkommen (z.B. wenn nur per Rapport erfasst).
      supabase.rpc("get_assignable_users"),
    ]);
    if (jobsRes.error) TOAST.supabaseError(jobsRes.error, "Aufträge konnten nicht geladen werden");
    if (belegeRes.error) TOAST.supabaseError(belegeRes.error, "Belege konnten nicht geladen werden");
    setJobs((jobsRes.data as unknown as UnbilledJob[]) ?? []);
    setBelege((belegeRes.data as unknown as UnfiledBeleg[]) ?? []);
    const nameMap = new Map<string, string>();
    for (const u of (usersRes.data as { id: string; full_name: string }[] | null) ?? []) {
      nameMap.set(u.id, u.full_name);
    }
    setNamesById(nameMap);

    // Trend aggregieren
    const minutesByMonth = new Map<string, number>();
    type TrendJobRow = { invoiced_at: string | null; time_entries: { clock_in: string; clock_out: string | null }[] | null };
    for (const job of (trendRes.data as TrendJobRow[] | null) ?? []) {
      if (!job.invoiced_at) continue;
      const monthKey = job.invoiced_at.slice(0, 7); // "2026-05"
      const minutes = (job.time_entries ?? []).reduce((sum, te) => {
        if (!te.clock_out) return sum;
        return sum + (new Date(te.clock_out).getTime() - new Date(te.clock_in).getTime()) / 60000;
      }, 0);
      minutesByMonth.set(monthKey, (minutesByMonth.get(monthKey) ?? 0) + minutes);
    }
    const trendData: TrendMonth[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      trendData.push({
        key,
        label: MONTH_LABELS_DE[d.getMonth()],
        hours: (minutesByMonth.get(key) ?? 0) / 60,
        isCurrent: i === 0,
      });
    }
    setTrend(trendData);

    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  function openJobModal(job: UnbilledJob) {
    setModal({ kind: "job", job });
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
    // Reject braucht eine Begruendung (>= 1 Zeichen, max 500).
    if (modal.kind === "beleg-reject") {
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
      confirmMessage = `Der Auftrag INT-${modal.job.job_number ?? "?"} wird als abgerechnet markiert. Die Nummer kann nur über die Datenbank geändert werden.`;
    } else if (modal.kind === "beleg") {
      confirmTitle = `Beleg-Referenz Nr. ${trimmed} bestätigen?`;
      confirmMessage = `Das Beleg-Ticket T-${modal.beleg.ticket_number} wird als abgelegt markiert (Status: erledigt). Die Nummer kann nur über die Datenbank geändert werden.`;
    } else {
      confirmTitle = `Beleg T-${modal.beleg.ticket_number} ablehnen?`;
      confirmMessage = `Der Mitarbeiter sieht die Begründung im Ticket-Detail. Status wird auf "abgelehnt" gesetzt.`;
      variant = "red";
    }
    const ok = await confirm({
      title: confirmTitle,
      message: confirmMessage,
      confirmLabel: modal.kind === "beleg-reject" ? "Definitiv ablehnen" : "Definitiv bestätigen",
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
    } else if (modal.kind === "beleg") {
      url = `/api/tickets/${modal.beleg.id}/mark-filed`;
      body = { filed_reference: trimmed };
    } else {
      url = `/api/tickets/${modal.beleg.id}/reject-beleg`;
      body = { reason: trimmed };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setSubmitting(false);
    if (!json.success) {
      TOAST.errorOr(json.error, "Aktion fehlgeschlagen");
      return;
    }
    if (modal.kind === "job") {
      toast.success(`INT-${modal.job.job_number ?? "?"} als Rechnung ${trimmed} abgerechnet`);
      setJobs((prev) => prev.filter((j) => j.id !== modal.job.id));
    } else if (modal.kind === "beleg") {
      toast.success(`Beleg T-${modal.beleg.ticket_number} abgelegt (${trimmed})`);
      setBelege((prev) => prev.filter((b) => b.id !== modal.beleg.id));
    } else {
      toast.success(`Beleg T-${modal.beleg.ticket_number} abgelehnt`);
      setBelege((prev) => prev.filter((b) => b.id !== modal.beleg.id));
    }
    setModal(null);
    setReference("");
  }

  const canEdit = useMemo(() => can("abrechnung:edit"), [can]);

  if (!ready) return null;

  const modalKind = modal?.kind ?? null;
  const isJobModal = modalKind === "job";
  const isBelegFile = modalKind === "beleg";
  const isBelegReject = modalKind === "beleg-reject";

  const modalTitle = !modal
    ? ""
    : modal.kind === "job"
      ? `Rechnung gestellt für INT-${modal.job.job_number ?? "?"}`
      : modal.kind === "beleg"
        ? `Beleg abgelegt — T-${modal.beleg.ticket_number}`
        : `Beleg ablehnen — T-${modal.beleg.ticket_number}`;
  const modalIcon = isJobModal
    ? <Receipt className="h-5 w-5 text-blue-500" />
    : isBelegFile
      ? <FolderArchive className="h-5 w-5 text-blue-500" />
      : <XCircle className="h-5 w-5 text-red-500" />;
  const fieldLabel = isJobModal
    ? "Rechnungsnummer"
    : isBelegFile
      ? "Ablage-Referenz"
      : "Begründung für Ablehnung";
  const fieldHint = isJobModal
    ? `Rechnungsnummer aus Bexio o.ä.`
    : isBelegFile
      ? `Bexio-Beleg-Nummer oder andere Ablage-Referenz.`
      : `Wird dem Mitarbeiter im Ticket-Detail angezeigt.`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Abrechnung</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Aufträge mit gestellter Rechnung und Belege als abgelegt markieren.
        </p>
      </div>

      {!loading && (
        <div className="hidden md:block">
          <TrendChart data={trend} />
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Lade…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-y-6 lg:gap-y-0">
          {/* Linke Spalte — Auftraege. lg:border-r + Padding macht den
              Trennstrich in der Mitte; auf Mobile (stacked) kein Border. */}
          <div className="space-y-3 lg:pr-6 lg:border-r lg:border-border">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Aufträge
              </h2>
              {jobs.length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {jobs.length} offen
                </span>
              )}
            </div>
            {jobs.length === 0 ? (
              <EmptyState message="Alles abgerechnet." sub="Sobald ein Auftrag abgeschlossen wird, taucht er hier auf." />
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <JobCard key={job.id} job={job} onMarkBilled={() => openJobModal(job)} canEdit={canEdit} onPreview={setPreviewDoc} namesById={namesById} />
                ))}
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
                  {belege.length} offen
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
          {isBelegReject ? (
            // Reject braucht Textarea fuer die Begruendung.
            <textarea
              value={reference}
              onChange={(e) => setReference(e.target.value.slice(0, 500))}
              placeholder="z.B. fehlender Beleg, falscher Betrag, nicht genehmigt..."
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
            className={`flex-1 ${isBelegReject ? "kasten kasten-red" : "kasten kasten-green"}`}
          >
            {isJobModal ? (
              <Receipt className="h-3.5 w-3.5" />
            ) : isBelegFile ? (
              <FolderArchive className="h-3.5 w-3.5" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            {submitting ? "Speichere…" : isBelegReject ? "Ablehnen" : "Bestätigen"}
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
// TrendChart — Stunden pro Monat, letzte 6 Monate
// =====================================================================

function TrendChart({ data }: { data: TrendMonth[] }) {
  const totalHours = data.reduce((sum, d) => sum + d.hours, 0);
  // maxHours dient nur der Skalierung — minimum 1 damit nicht durch 0 geteilt wird.
  const maxHours = Math.max(...data.map((d) => d.hours), 1);
  // Vergleich: Vorhergehender Monat vs aktueller. Praktisch fuer "Trend-
  // Pfeil"-Anzeige (geht's hoch oder runter?).
  const current = data[data.length - 1]?.hours ?? 0;
  const previous = data[data.length - 2]?.hours ?? 0;
  const delta = previous > 0 ? ((current - previous) / previous) * 100 : null;
  const trendUp = delta !== null && delta > 5;
  const trendDown = delta !== null && delta < -5;

  return (
    <Card className="bg-card">
      <CardContent className="p-3">
        {/* Header + Chart kompakt: Header in einer Zeile, gleich darunter
            der Bar-Chart. Subtitle weggelassen — Title + Icon erklaeren
            es bereits. */}
        <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
          <h2 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5 text-muted-foreground">
            <Clock className="h-3.5 w-3.5 text-teal-500" />
            Abgerechnete Stunden
          </h2>
          <div className="flex items-baseline gap-2.5">
            {delta !== null && (
              <span
                className={`text-[11px] font-medium tabular-nums ${
                  trendUp ? "text-green-600 dark:text-green-400"
                    : trendDown ? "text-red-600 dark:text-red-400"
                    : "text-muted-foreground"
                }`}
              >
                {trendUp ? "↑" : trendDown ? "↓" : "→"} {Math.abs(Math.round(delta))}%
              </span>
            )}
            <div className="text-base font-bold tabular-nums leading-none">
              {Math.round(totalHours)}h
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-normal ml-1.5">Gesamt</span>
            </div>
          </div>
        </div>

        {/* Bar-Bereich: 56px verfuegbar fuer Bar (66 - 10 Wert-Label).
            Pixel-basiert damit Bars auch in flex-Containers korrekt rendern. */}
        <div className="flex items-end gap-2 mb-1" style={{ height: 66 }}>
          {data.map((m) => {
            const BAR_AREA_PX = 56;
            const heightPx = m.hours > 0 ? Math.max((m.hours / maxHours) * BAR_AREA_PX, 3) : 0;
            return (
              <div key={m.key} className="flex-1 flex flex-col items-center justify-end min-w-0">
                {m.hours > 0 && (
                  <div className="text-[9px] tabular-nums text-muted-foreground mb-0.5 leading-none">
                    {Math.round(m.hours)}h
                  </div>
                )}
                <div
                  className={`w-full rounded-t transition-all bg-[rgba(20,184,166,0.12)] dark:bg-[rgba(20,184,166,0.18)] ${
                    m.hours > 0
                      ? `border-2 ${m.isCurrent ? "border-dashed" : "border-solid"} border-[rgb(20,184,166)]`
                      : ""
                  }`}
                  style={{ height: `${heightPx}px` }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          {data.map((m) => (
            <div
              key={m.key}
              className={`flex-1 text-[10px] text-center tabular-nums ${m.isCurrent ? "font-semibold" : "text-muted-foreground"}`}
            >
              {m.label}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
    <span className="inline-flex items-center font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded border border-foreground/15 bg-foreground/[0.04] dark:bg-foreground/[0.06] shrink-0">
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

interface JobCardProps {
  job: UnbilledJob;
  onMarkBilled: () => void;
  canEdit: boolean;
  onPreview: (doc: { url: string; title: string }) => void;
  namesById: Map<string, string>;
}

function JobCard({ job, onMarkBilled, canEdit, onPreview, namesById }: JobCardProps) {
  const report = job.service_reports[0] ?? null;
  const stempelByUser = aggregatePerUser(job.time_entries);
  const rapportByUser = aggregateReportPerUser(job.service_reports);
  // Union aus Stempel + Rapport, sortiert nach Stempel-Stunden absteigend,
  // dann Rapport-Stunden — damit der oberste User typischerweise der
  // tatsaechlich aktivste ist.
  const userIds = Array.from(new Set([...stempelByUser.keys(), ...rapportByUser.keys()]));
  const perUser = userIds.map((id) => ({
    userId: id,
    name: stempelByUser.get(id)?.name ?? namesById.get(id) ?? "Unbekannt",
    stempel: stempelByUser.get(id)?.minutes ?? 0,
    rapport: rapportByUser.get(id) ?? 0,
  })).sort((a, b) => (b.stempel - a.stempel) || (b.rapport - a.rapport));
  const totalStempel = perUser.reduce((sum, p) => sum + p.stempel, 0);
  const totalRapport = perUser.reduce((sum, p) => sum + p.rapport, 0);
  const dateRange = job.start_date && job.end_date && job.start_date !== job.end_date
    ? `${formatDate(job.start_date)} – ${formatDate(job.end_date)}`
    : formatDate(job.end_date ?? job.start_date);

  return (
    <Card className="bg-card overflow-hidden">
      {/* Header — items-center vertikal-zentriert den Button mit dem Text-Block,
          unabhaengig von Title-/Meta-Zeilenanzahl. */}
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <IdentifierBadge prefix="INT" number={job.job_number} />
          </div>
          <h3 className="font-semibold text-sm truncate">
            <Link href={`/auftraege/${job.id}`} className="hover:underline">{job.title}</Link>
          </h3>
          <MetaLine items={[job.customer?.name, dateRange, job.location?.name]} />
        </div>
        {canEdit && (
          <button type="button" onClick={onMarkBilled} className="kasten kasten-green shrink-0">
            <Receipt className="h-3.5 w-3.5" />
            Rechnung gestellt
          </button>
        )}
      </div>

      {/* Body — getrennt durch dezente Border-Linie */}
      <div className="border-t px-4 py-3 space-y-3">
        <div>
          <div className="flex items-center justify-between gap-2">
            <SectionLabel icon={FileText}>Arbeitsrapport</SectionLabel>
            {report?.pdf_url && (
              <button
                type="button"
                onClick={async () => {
                  const supabase = createClient();
                  const { data, error } = await supabase.storage.from("documents").createSignedUrl(report.pdf_url!, 3600);
                  if (error || !data?.signedUrl) {
                    toast.error("PDF nicht verfügbar — eventuell aus altem Bestand vor 6.5.2026");
                    return;
                  }
                  onPreview({ url: data.signedUrl, title: `Rapport INT-${job.job_number}` });
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
              <div className="flex items-center gap-6 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <span className="w-16 text-right">Stempel</span>
                <span className="w-16 text-right">Rapport</span>
              </div>
            )}
          </div>
          {perUser.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Keine Stempelzeiten oder Rapport-Stunden erfasst.</p>
          ) : (
            <div className="text-xs space-y-0.5">
              {perUser.map((p) => (
                <div key={p.userId} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="text-muted-foreground truncate min-w-0 flex-1">{p.name}</span>
                  <div className="flex items-center gap-6 shrink-0">
                    <span className="font-mono tabular-nums w-16 text-right">
                      {p.stempel > 0 ? formatHours(p.stempel) : <span className="text-muted-foreground/50">—</span>}
                    </span>
                    <span className="font-mono tabular-nums w-16 text-right">
                      {p.rapport > 0 ? formatHours(p.rapport) : <span className="text-muted-foreground/50">—</span>}
                    </span>
                  </div>
                </div>
              ))}
              {/* Total-Zeile als Summen-Footer */}
              <div className="flex items-center justify-between gap-2 mt-1.5 pt-1.5 border-t font-semibold text-sm">
                <span>Total</span>
                <div className="flex items-center gap-6 shrink-0">
                  <span className="font-mono tabular-nums w-16 text-right">
                    {totalStempel > 0 ? formatHours(totalStempel) : <span className="text-muted-foreground/50">—</span>}
                  </span>
                  <span className="font-mono tabular-nums w-16 text-right">
                    {totalRapport > 0 ? formatHours(totalRapport) : <span className="text-muted-foreground/50">—</span>}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
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
            <IdentifierBadge prefix="T" number={beleg.ticket_number} />
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
