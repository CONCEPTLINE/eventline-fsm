"use client";

/**
 * HR → Anfragen-Tab (admin-only).
 *
 * Ersetzt den frueheren „Uebersicht"-Tab. Zwei Bloecke:
 *   1. Aktions-Liste — alles was ein Admin heute pruefen sollte:
 *      Ferienantraege (mit Inline-Genehmigen/Ablehnen),
 *      Stempel-Aenderungs-Tickets, andere offene Tickets.
 *   2. Mitarbeiter-Ampel — jeder aktive Techniker als kompakte Zeile mit
 *      Monats-Stunden, naechstem Einsatz und aktuellem Status
 *      (eingestempelt / in Abwesenheit).
 *
 * Daten kommen aggregiert von /api/hr/anfragen (Admin-only, parallel-
 * queried). Ferien-Entscheidung nutzt den bestehenden Endpoint
 * /api/time-off/[id]/decide.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Palmtree, TicketCheck, Clock, Wrench, Receipt, Package,
  Check, X, Loader2, Inbox, Users, ChevronRight, CircleDot,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ZRH_TZ } from "@/lib/swiss-time";

interface FerienAntrag {
  id: string;
  user_id: string;
  user_name: string;
  type: string;
  start_date: string;
  end_date: string;
  created_at: string;
  note: string | null;
}
interface StempelAntrag {
  id: string;
  ticket_number: number;
  title: string;
  created_at: string;
  user_id: string;
  user_name: string;
}
interface AndererTicket {
  id: string;
  ticket_number: number;
  type: string;
  title: string;
  created_at: string;
  user_id: string;
  user_name: string;
}
interface MitarbeiterAmpel {
  id: string;
  full_name: string;
  month_minutes: number;
  next_shift: {
    start_time: string;
    job_id: string;
    job_number: number | null;
    job_title: string | null;
  } | null;
  is_active_stamped: boolean;
  active_since_iso: string | null;
  current_absence: { type: string; end_date: string } | null;
}
interface AnfragenPayload {
  success: boolean;
  ferienAntraege: FerienAntrag[];
  stempelAntraege: StempelAntrag[];
  andereTickets: AndererTicket[];
  mitarbeiter: MitarbeiterAmpel[];
}

const TIME_OFF_LABEL: Record<string, string> = {
  ferien: "Ferien", krank: "Krank", kompensation: "Kompensation",
  frei: "Frei", militaer: "Militär",
};

const TICKET_TYPE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; className: string }> = {
  it:       { label: "IT",       icon: Wrench,  className: "text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-500/20" },
  beleg:    { label: "Beleg",    icon: Receipt, className: "text-amber-700  dark:text-amber-300  bg-amber-100  dark:bg-amber-500/20" },
  material: { label: "Material", icon: Package, className: "text-red-700    dark:text-red-300    bg-red-100    dark:bg-red-500/20" },
};

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("de-CH", {
    timeZone: ZRH_TZ, day: "2-digit", month: "2-digit", year: "numeric",
  });
}

function fmtDateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("de-CH", {
    timeZone: ZRH_TZ, day: "2-digit", month: "2-digit",
  });
}

function fmtDurRange(fromIso: string, toIso: string): string {
  return fromIso === toIso ? fmtDate(fromIso) : `${fmtDateShort(fromIso)} – ${fmtDate(toIso)}`;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: ZRH_TZ, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtHours(minutes: number): string {
  if (minutes <= 0) return "0h";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function fmtActiveSince(iso: string): string {
  const start = new Date(iso).getTime();
  const diffMin = Math.max(0, Math.floor((Date.now() - start) / 60000));
  return fmtHours(diffMin);
}

export function AnfragenTab({ onGoto }: { onGoto: (tab: "stempelzeiten" | "tickets" | "ferien") => void }) {
  const [data, setData] = useState<AnfragenPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/hr/anfragen", { cache: "no-store" });
      const j = (await res.json()) as AnfragenPayload | { success: false; error?: string };
      if (!("success" in j) || !j.success) {
        toast.error(("error" in j && j.error) || "Anfragen konnten nicht geladen werden");
        return;
      }
      setData(j as AnfragenPayload);
    } catch {
      toast.error("Netzwerkfehler beim Laden der Anfragen");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function decideFerien(id: string, decision: "genehmigen" | "ablehnen") {
    setDecidingId(id + ":" + decision);
    try {
      let note = "";
      if (decision === "ablehnen") {
        const input = typeof window !== "undefined" ? window.prompt("Begründung für Ablehnung (Pflicht):", "") : "";
        if (!input || !input.trim()) {
          toast.error("Ablehnung ohne Begründung nicht möglich");
          return;
        }
        note = input.trim();
      }
      const res = await fetch(`/api/time-off/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note || undefined }),
      });
      const j = (await res.json()) as { success: boolean; error?: string };
      if (!j.success) {
        toast.error(j.error || "Entscheidung konnte nicht gespeichert werden");
        return;
      }
      toast.success(decision === "genehmigen" ? "Antrag genehmigt" : "Antrag abgelehnt");
      await load();
    } catch {
      toast.error("Netzwerkfehler");
    } finally {
      setDecidingId(null);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Anfragen werden geladen…
      </div>
    );
  }
  if (!data) return null;

  // Fuer die kombinierte Aktions-Liste (chronologisch sortiert, Top 10):
  interface ActionRow {
    kind: "ferien" | "stempel" | "ticket";
    id: string;
    created_at: string;
  }
  const allActions: ActionRow[] = [
    ...data.ferienAntraege.map((f) => ({ kind: "ferien" as const, id: f.id, created_at: f.created_at })),
    ...data.stempelAntraege.map((s) => ({ kind: "stempel" as const, id: s.id, created_at: s.created_at })),
    ...data.andereTickets.map((t) => ({ kind: "ticket" as const, id: t.id, created_at: t.created_at })),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const totalActions = allActions.length;
  const shownActions = allActions.slice(0, 10);

  const ferienById = new Map(data.ferienAntraege.map((f) => [f.id, f]));
  const stempelById = new Map(data.stempelAntraege.map((s) => [s.id, s]));
  const ticketById = new Map(data.andereTickets.map((t) => [t.id, t]));

  return (
    <div className="space-y-6">
      {/* ----------------- Aktions-Liste ----------------- */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Zu bearbeiten {totalActions > 0 && <span className="ml-1 opacity-70">({totalActions})</span>}
          </p>
        </div>

        {totalActions === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Keine offenen Anfragen"
            description="Alle Abwesenheiten und Tickets sind bearbeitet."
          />
        ) : (
          <div className="divide-y divide-border/60">
            {shownActions.map((a) => {
              if (a.kind === "ferien") {
                const f = ferienById.get(a.id)!;
                return (
                  <FerienZeile
                    key={"f-" + f.id}
                    f={f}
                    decidingId={decidingId}
                    onDecide={decideFerien}
                  />
                );
              }
              if (a.kind === "stempel") {
                const s = stempelById.get(a.id)!;
                return <StempelZeile key={"s-" + s.id} s={s} />;
              }
              const t = ticketById.get(a.id)!;
              return <TicketZeile key={"t-" + t.id} t={t} />;
            })}
          </div>
        )}

        {totalActions > shownActions.length && (
          <div className="border-t border-border/60 px-4 py-2 flex flex-wrap items-center gap-3">
            {data.ferienAntraege.length > 3 && (
              <button
                type="button"
                onClick={() => onGoto("ferien")}
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              >
                Alle {data.ferienAntraege.length} Abwesenheits-Anträge
              </button>
            )}
            {data.stempelAntraege.length + data.andereTickets.length > 3 && (
              <button
                type="button"
                onClick={() => onGoto("tickets")}
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              >
                Alle Tickets ({data.stempelAntraege.length + data.andereTickets.length})
              </button>
            )}
          </div>
        )}
      </div>

      {/* ----------------- Mitarbeiter-Ampel ----------------- */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5">
            <Users className="h-3 w-3" />
            Mitarbeiter {data.mitarbeiter.length > 0 && <span className="opacity-70">({data.mitarbeiter.length})</span>}
          </p>
        </div>

        {data.mitarbeiter.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Keine aktiven Techniker"
            description="Sobald Techniker aktiviert sind, erscheinen sie hier."
          />
        ) : (
          <div className="divide-y divide-border/60">
            {data.mitarbeiter.map((m) => (
              <MitarbeiterZeile key={m.id} m={m} onGoto={onGoto} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Zeilen-Sub-Komponenten
// ============================================================

function FerienZeile({
  f, decidingId, onDecide,
}: {
  f: FerienAntrag;
  decidingId: string | null;
  onDecide: (id: string, decision: "genehmigen" | "ablehnen") => void;
}) {
  const genPending = decidingId === f.id + ":genehmigen";
  const abPending = decidingId === f.id + ":ablehnen";
  const anyPending = genPending || abPending;

  return (
    <div className="row-hover [--row-hover-x:0.5rem] flex flex-wrap items-center gap-3 px-4 py-2.5">
      <span className="shrink-0 h-6 w-6 rounded-md bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 inline-flex items-center justify-center">
        <Palmtree className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          <span className="font-medium">{f.user_name}</span>
          <span className="text-muted-foreground"> · {TIME_OFF_LABEL[f.type] ?? f.type} · {fmtDurRange(f.start_date, f.end_date)}</span>
        </div>
        {f.note && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">„{f.note}"</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => onDecide(f.id, "genehmigen")}
          disabled={anyPending}
          className="kasten kasten-green text-xs px-2 py-1 inline-flex items-center gap-1 disabled:opacity-60"
          data-tooltip="Antrag genehmigen"
        >
          {genPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Genehmigen
        </button>
        <button
          type="button"
          onClick={() => onDecide(f.id, "ablehnen")}
          disabled={anyPending}
          className="kasten kasten-red text-xs px-2 py-1 inline-flex items-center gap-1 disabled:opacity-60"
          data-tooltip="Antrag ablehnen (Begründung Pflicht)"
        >
          {abPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
          Ablehnen
        </button>
      </div>
    </div>
  );
}

function StempelZeile({ s }: { s: StempelAntrag }) {
  return (
    <Link href={`/tickets/${s.id}`} className="row-hover [--row-hover-x:0.5rem] flex items-center gap-3 px-4 py-2.5">
      <span className="shrink-0 h-6 w-6 rounded-md bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300 inline-flex items-center justify-center">
        <Clock className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          <span className="font-medium">#{s.ticket_number}</span>
          <span className="text-muted-foreground"> · {s.user_name} · </span>
          <span>{s.title}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Stempel-Änderung · {fmtDateTime(s.created_at)}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </Link>
  );
}

function TicketZeile({ t }: { t: AndererTicket }) {
  const meta = TICKET_TYPE_META[t.type] ?? { label: t.type, icon: TicketCheck, className: "text-muted-foreground bg-muted" };
  const Icon = meta.icon;
  return (
    <Link href={`/tickets/${t.id}`} className="row-hover [--row-hover-x:0.5rem] flex items-center gap-3 px-4 py-2.5">
      <span className={`shrink-0 h-6 w-6 rounded-md inline-flex items-center justify-center ${meta.className}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          <span className="font-medium">#{t.ticket_number}</span>
          <span className="text-muted-foreground"> · {t.user_name} · </span>
          <span>{t.title}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {meta.label} · {fmtDateTime(t.created_at)}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </Link>
  );
}

function MitarbeiterZeile({
  m, onGoto,
}: {
  m: MitarbeiterAmpel;
  onGoto: (tab: "stempelzeiten" | "tickets" | "ferien") => void;
}) {
  const initials = m.full_name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <button
      type="button"
      onClick={() => onGoto("stempelzeiten")}
      data-tooltip="Stempelzeiten öffnen"
      className="row-hover [--row-hover-x:0.5rem] w-full flex items-center gap-3 px-4 py-2.5 text-left"
    >
      <span className="shrink-0 h-8 w-8 rounded-full bg-muted text-foreground/70 inline-flex items-center justify-center text-xs font-semibold">
        {initials || "?"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium truncate">{m.full_name}</span>
          {m.is_active_stamped && m.active_since_iso && (
            <span
              className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md bg-green-100 dark:bg-green-500/25 text-green-700 dark:text-green-300"
              data-tooltip={`Eingestempelt seit ${new Date(m.active_since_iso).toLocaleTimeString("de-CH", { timeZone: ZRH_TZ, hour: "2-digit", minute: "2-digit" })}`}
            >
              <CircleDot className="h-2.5 w-2.5" />
              {fmtActiveSince(m.active_since_iso)}
            </span>
          )}
          {m.current_absence && (
            <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-md bg-amber-100 dark:bg-amber-500/25 text-amber-700 dark:text-amber-300">
              {TIME_OFF_LABEL[m.current_absence.type] ?? m.current_absence.type} bis {fmtDateShort(m.current_absence.end_date)}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {m.next_shift ? (
            <>
              Nächst: {fmtDateTime(m.next_shift.start_time)}
              {m.next_shift.job_number != null && (
                <> · #{m.next_shift.job_number}</>
              )}
              {m.next_shift.job_title && (
                <> · {m.next_shift.job_title}</>
              )}
            </>
          ) : (
            <>Kein geplanter Einsatz</>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">{fmtHours(m.month_minutes)}</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Monat</div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}
