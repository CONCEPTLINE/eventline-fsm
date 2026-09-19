"use client";

/**
 * Auftrag-Detail: Sticky-Header (Nummer/Titel/Badges/Meta/Aktionen/Tab-Nav).
 *
 * Sitzt oben in der Detail-Seite und bleibt beim Scrollen an der oberen
 * Kante des #app-scroll-Wrappers stehen. Alle Zustands-Actions (Freigeben,
 * Abschliessen, Bearbeiten, Stornieren, Stempeln) sitzen direkt in der
 * Aktions-Bar — kein Overflow-Menu mehr; Farbtrennung (blau=primaer,
 * gruen=abschliessen, rot=destruktiv) verhindert Klick-Verwechslungen.
 */

import { type ReactNode, useState, useEffect } from "react";
import {
  MapPin,
  User,
  Calendar,
  XCircle,
  AlertCircle,
  Inbox,
  Phone,
  PhoneCall,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { BackButton } from "@/components/ui/back-button";
import { JobNumber } from "@/components/job-number";
import { JobStempelButton } from "@/components/stempel/job-stempel-button";
import { TabsNav } from "@/components/ui/tabs-nav";
import { JOB_STATUS } from "@/lib/constants";
import type { JobDetailWithRelations, JobStatus } from "@/types";

export type TabKey = "uebersicht" | "eingang" | "rapport" | "dokumente";

type StatusAction = {
  from: JobStatus[];
  to: JobStatus;
  label: string;
  icon: React.ReactNode;
  variant: "primary" | "outline" | "destructive";
};

type Tab = { key: TabKey; label: string; icon: React.ReactNode };

type Props = {
  jobId: string;
  job: JobDetailWithRelations;
  canEdit: boolean;
  availableActions: StatusAction[];
  onStatusAction: (to: JobStatus) => void | Promise<void>;
  onOpenCancel: () => void;
  canFinish: boolean;
  finishBlockReason: string;
  tabs: Tab[];
  activeTab: TabKey;
  onSelectTab: (t: TabKey) => void;
  /** Auto-abgeleiteter "was jetzt?"-Chip — die Detail-Page erzeugt ihn
   *  ueber <AuftragNextActionChip> und reicht ihn hier durch, damit der
   *  Header keine Modal-/Status-Callbacks kennen muss. */
  nextActionChip?: ReactNode;
  /** Ruft die Detail-Page auf, damit sie den Job neu laedt — z.B. nach
   *  dem "Kunde kontaktiert"-Toggle. Optional damit Aufrufer ohne
   *  Reload-Handler nicht brechen. */
  onReload?: () => void | Promise<void>;
};

export function AuftragStickyHeader({
  jobId,
  job,
  canEdit,
  availableActions,
  onStatusAction,
  onOpenCancel,
  canFinish,
  finishBlockReason,
  tabs,
  activeTab,
  onSelectTab,
  nextActionChip,
  onReload,
}: Props) {
  const customer = job.customer ?? job.location?.customer ?? undefined;
  const location = job.location ?? undefined;
  const room = job.room ?? undefined;
  const isDringend = job.priority === "dringend";

  const eventDateLabel = job.start_date
    ? `${new Date(job.start_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}${
        job.end_date && job.end_date !== job.start_date
          ? ` – ${new Date(job.end_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}`
          : ""
      }`
    : "";
  const locationLabel = location?.name ?? room?.name ?? job.external_address ?? "";

  return (
    <div className="sticky top-0 z-20 bg-[#f5f5f7]/85 dark:bg-[#0a0a0a]/85 backdrop-blur-md pt-1 pb-4 mb-8">
      <div className="flex items-start gap-3">
        <BackButton fallbackHref="/auftraege" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <JobNumber number={job.job_number} size="md" />
            {job.status !== "offen" && (
              <span
                className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full ${JOB_STATUS[job.status].color}`}
              >
                {JOB_STATUS[job.status].label}
              </span>
            )}
            {isDringend && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300">
                <AlertCircle className="h-3 w-3" />
                Dringend
              </span>
            )}
            {job.was_anfrage && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-foreground/[0.06] text-muted-foreground"
                data-tooltip="Aus einer Vermietungs-Anfrage entstanden"
              >
                <Inbox className="h-3 w-3" />
                Vermietung
              </span>
            )}
            {/* Auto-abgeleiteter "was jetzt?"-Chip — Klick fuehrt direkt
                zur naechsten sinnvollen Aktion (Termine anlegen, Personal
                zuteilen, Rapport starten, Rechnung stellen etc.). Rendert
                null wenn nichts ansteht (z.B. sauberer abgerechneter Job). */}
            {nextActionChip}
          </div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight truncate mt-0.5">{job.title}</h1>
          {(customer?.name || locationLabel || eventDateLabel) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-1">
              {customer?.name && (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <User className="h-3 w-3 shrink-0" />
                  <span className="truncate">{customer.name}</span>
                </span>
              )}
              {locationLabel && (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate">{locationLabel}</span>
                </span>
              )}
              {eventDateLabel && (
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3 shrink-0" />
                  <span className="tabular-nums">{eventDateLabel}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Aktions-Bar */}
      <div className="flex flex-wrap gap-2 mt-3">
        {availableActions
          .filter((a) => a.to !== "storniert")
          .filter((a) => a.to === "abgeschlossen" || canEdit)
          .map((a) => {
            // Visuelle Grammatik: EINE Primaer-Aktion pro Screen (Audit
            // Thema 5, Regel 1). Rot ist reserviert fuer destruktive
            // Aktionen (Stornieren, Loeschen). Positive Primaerer wie
            // Freigeben/Abschliessen sind blau bzw. gruen.
            const isFinish = a.to === "abgeschlossen";
            const isPrimary = a.variant === "primary";
            const tone = isFinish ? "kasten-green" : isPrimary ? "kasten-blue" : "kasten-muted";
            const isRelease = a.to === "offen";
            const releaseBlocked = isRelease && (!job.start_date || !job.end_date);
            return (
              <button
                key={a.to}
                type="button"
                onClick={() => onStatusAction(a.to)}
                disabled={releaseBlocked}
                data-tooltip={releaseBlocked ? "Bitte erst Datum im Bearbeiten-Modus setzen" : undefined}
                className={`kasten ${tone}`}
              >
                {a.icon}
                {a.label}
              </button>
            );
          })}

        {canEdit && availableActions.some((a) => a.to === "storniert") && (
          // Stornieren als direkter Button (nicht mehr im Overflow-Menu).
          // Rot ist app-weit ONLY fuer destruktive Aktionen reserviert, und
          // die positiv-primaeren Buttons daneben nutzen kasten-blue
          // (Freigeben) bzw. kasten-green (Abschliessen) — klare visuelle
          // Trennung durch Farbe, kein Klick-Risiko.
          <button
            type="button"
            onClick={onOpenCancel}
            className="kasten kasten-red"
            data-tooltip="Auftrag stornieren"
            data-tooltip-align="end"
          >
            <XCircle className="h-4 w-4" />
            Stornieren
          </button>
        )}

        {job.status === "offen" && (
          <JobStempelButton jobId={jobId} jobNumber={job.job_number} />
        )}

        {/* "Kunde kontaktiert"-Toggle — Follow-up-Tracking (Migration 211).
            Verhindert doppelte Anrufe, wenn mehrere Team-Member denselben
            Auftrag klaeren. Nur sichtbar wenn der Auftrag nicht gerade
            partner_anfrage oder storniert ist — in diesen Zustaenden
            gibt es ohnehin keinen "Kunden anrufen"-Sinn. */}
        {job.status !== "partner_anfrage" && job.status !== "storniert" && (
          <KundeKontaktiertButton
            jobId={jobId}
            contactedAt={job.customer_contacted_at}
            contactedByName={job.customer_contacted_by_profile?.full_name ?? null}
            onReload={onReload}
          />
        )}
      </div>

      {/* End-Date-Hint */}
      {!canFinish && job.status === "offen" && finishBlockReason && (
        <p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1.5">
          <AlertCircle className="h-3 w-3" />
          {finishBlockReason} — Rapport kann jedoch schon jetzt vorbereitet werden.
        </p>
      )}

      {/* Tab-Nav */}
      <TabsNav
        tabs={tabs}
        active={activeTab}
        onChange={(k) => onSelectTab(k as TabKey)}
        className="mt-3"
        ariaLabel="Auftrag-Bereiche"
      />
    </div>
  );
}

// =====================================================================
// KundeKontaktiertButton — Toggle mit Optimistic-Reload
// =====================================================================
// - NULL customer_contacted_at → "Kunde kontaktieren" (kasten-muted + Phone)
//   Klick → POST /api/auftraege/[id]/customer-contacted
// - gesetzt → "Kontaktiert · vor N …" (kasten-green + PhoneCall)
//   Klick → DELETE (Undo)
// Tooltip zeigt volles Datum (Europe/Zurich §4) + Name aus profiles-Join.
// useTransition sorgt fuer disabled+Spinner (siehe §7 Grundregel).

function relativeSince(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60_000) return "gerade eben";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `vor ${mins} Min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours} Std`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "gestern";
  if (days < 7) return `vor ${days} Tagen`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `vor ${weeks} ${weeks === 1 ? "Woche" : "Wochen"}`;
  // Fallback: hartes Datum (Europe/Zurich — §4 CLAUDE.md).
  return new Date(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });
}

function KundeKontaktiertButton({
  jobId,
  contactedAt,
  contactedByName,
  onReload,
}: {
  jobId: string;
  contactedAt: string | null;
  contactedByName: string | null;
  onReload?: () => void | Promise<void>;
}) {
  // Optimistic-State: UI reagiert SOFORT, POST laeuft im Hintergrund.
  // Kein loadAll()-Warten mehr — der Button fuehlt sich instant an.
  // Falls Server ablehnt: revert + Toast.
  const [localContactedAt, setLocalContactedAt] = useState<string | null>(contactedAt);
  const [localContactedByName, setLocalContactedByName] = useState<string | null>(contactedByName);
  const [saving, setSaving] = useState(false);

  useEffect(() => setLocalContactedAt(contactedAt), [contactedAt]);
  useEffect(() => setLocalContactedByName(contactedByName), [contactedByName]);

  const isContacted = !!localContactedAt;

  const fullDateTooltip = localContactedAt
    ? new Date(localContactedAt).toLocaleString("de-CH", {
        timeZone: "Europe/Zurich",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  const tooltip = isContacted
    ? localContactedByName
      ? `Kontaktiert am ${fullDateTooltip} von ${localContactedByName}. Klick zum Rückgängig-Machen.`
      : `Kontaktiert am ${fullDateTooltip}. Klick zum Rückgängig-Machen.`
    : "Als 'Kunde kontaktiert' markieren, damit niemand doppelt anruft.";

  const onClick = async () => {
    if (saving) return;
    const wasContacted = isContacted;
    const prevAt = localContactedAt;
    const prevBy = localContactedByName;

    // Optimistic-Update: UI aendert sofort.
    if (wasContacted) {
      setLocalContactedAt(null);
      setLocalContactedByName(null);
    } else {
      setLocalContactedAt(new Date().toISOString());
      // contactedByName wird beim naechsten echten Reload gesetzt.
      // Fuer den Optimistic-Case: leer lassen (Tooltip zeigt trotzdem Datum).
    }
    setSaving(true);

    try {
      const res = await fetch(`/api/auftraege/${jobId}/customer-contacted`, {
        method: wasContacted ? "DELETE" : "POST",
      });
      const json = (await res.json().catch(() => null)) as
        | { success: boolean; error?: string; customer_contacted_at?: string | null }
        | null;
      if (!res.ok || !json?.success) {
        // Revert.
        setLocalContactedAt(prevAt);
        setLocalContactedByName(prevBy);
        const msg =
          json?.error ??
          (res.status === 403
            ? "Keine Berechtigung für diese Aktion."
            : "Aktion fehlgeschlagen. Bitte erneut versuchen.");
        toast.error(msg);
        return;
      }
      // Server-Timestamp adoptieren (praeziser als client-side new Date()).
      if (!wasContacted && json.customer_contacted_at) {
        setLocalContactedAt(json.customer_contacted_at);
      }
      // Kein blockendes onReload — der Parent-State wird bei naechster
      // Navigation eh frisch geladen. Falls doch synchronisiert werden soll:
      // im Hintergrund feuern (kein await).
      void onReload?.();
    } catch {
      setLocalContactedAt(prevAt);
      setLocalContactedByName(prevBy);
      toast.error("Netzwerkfehler — bitte erneut versuchen.");
    } finally {
      setSaving(false);
    }
  };
  const pending = saving;

  if (isContacted) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        data-tooltip={tooltip}
        className="kasten kasten-green"
      >
        {pending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <PhoneCall className="h-4 w-4" />
        )}
        Kontaktiert · {relativeSince(localContactedAt!)}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      data-tooltip={tooltip}
      className="kasten kasten-muted"
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Phone className="h-4 w-4" />
      )}
      Kunde kontaktieren
    </button>
  );
}
