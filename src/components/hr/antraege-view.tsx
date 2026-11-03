"use client";

/**
 * HR › Freigaben — Inhalt der Seite /antraege (Kopf + Rechte-Pruefung macht
 * die Seite; sichtbar nur mit ferien:approve, tickets:manage oder
 * stempelzeiten:see-all, Admin immer). „Anträge" = interne Anträge zum
 * Genehmigen — „Anfrage" ist in der App mehrfach belegt; der API-Name
 * (/api/hr/anfragen) bleibt.
 *
 * Ersetzt den frueheren „Uebersicht"-Tab. Zwei Bloecke:
 *   1. Aktions-Liste — alles was ein Admin heute pruefen sollte:
 *      Ferienantraege (mit Inline-Genehmigen/Ablehnen),
 *      Stempel-Aenderungs-Tickets, andere offene Tickets.
 *   2. Mitarbeiter-Ampel — jeder aktive Techniker als kompakte Zeile mit
 *      Monats-Stunden, naechstem Einsatz und aktuellem Status
 *      (eingestempelt / in Abwesenheit).
 * Weiter-Links fuehren auf die eigenen Seiten /ferien, /tickets und
 * /stempelzeiten — nur, wenn die Rolle die Zielseite sehen darf.
 *
 * Daten kommen aggregiert von /api/hr/anfragen (Admin-only, parallel-
 * queried). Ferien-Entscheidung nutzt den bestehenden Endpoint
 * /api/time-off/[id]/decide.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Palmtree, TicketCheck, Clock, Wrench, Receipt, Package,
  Check, X, Loader2, Inbox, Users, ChevronRight, CircleDot,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { TextLink } from "@/components/ui/text-knopf";
import { PersonAvatar } from "@/components/ui/person-avatar";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { usePermissions } from "@/lib/use-permissions";
import { ZRH_TZ } from "@/lib/swiss-time";
import { ABWESEND_LABEL } from "@/lib/abwesenheit-sichtbarkeit";

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
  frei: "Frei", militaer: "Militär", abwesend: ABWESEND_LABEL,
};

const TICKET_TYPE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; className: string }> = {
  it:       { label: "IT",       icon: Wrench,  className: "text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-500/15" },
  beleg:    { label: "Beleg",    icon: Receipt, className: "text-amber-600  dark:text-amber-400  bg-amber-50  dark:bg-amber-500/15" },
  material: { label: "Material", icon: Package, className: "text-red-600    dark:text-red-400    bg-red-50    dark:bg-red-500/15" },
};

/** Farbe der Abwesenheits-Kachel je Art — wie die Typen auf /ferien. */
const TIME_OFF_FARBE: Record<string, string> = {
  ferien: "bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200",
  krank: "bg-red-100 text-red-700 dark:bg-red-500/25 dark:text-red-200",
  kompensation: "bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-amber-200",
  frei: "bg-gray-100 text-gray-700 dark:bg-gray-500/25 dark:text-gray-200",
  militaer: "bg-green-100 text-green-700 dark:bg-green-500/25 dark:text-green-200",
};

/** Kleine Pille in der Zeile — Form wie die Status-Pillen auf /tickets. */
const PILLE = "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0 text-[10px] font-medium";

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

export function AntraegeView() {
  const { can } = usePermissions();
  // Weiter-Links nur auf Seiten, die die Rolle sehen darf (sonst schickt
  // der Layout-Guard aufs Dashboard). Abwesenheit sehen alle.
  const ticketsHref = can("tickets:view") ? "/tickets" : null;
  const stempelzeitenHref = can("stempelzeiten:view") ? "/stempelzeiten" : null;
  const [data, setData] = useState<AnfragenPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // Ablehnen fragt die Begruendung im Modal ab (wie /ferien), nicht per Browser-Dialog.
  const [ablehnen, setAblehnen] = useState<FerienAntrag | null>(null);
  const [begruendung, setBegruendung] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/hr/anfragen", { cache: "no-store" });
      const j = (await res.json()) as AnfragenPayload | { success: false; error?: string };
      if (!("success" in j) || !j.success) {
        toast.error(("error" in j && j.error) || "Anträge konnten nicht geladen werden");
        return;
      }
      setData(j as AnfragenPayload);
    } catch {
      toast.error("Netzwerkfehler beim Laden der Anträge");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function onDecide(f: FerienAntrag, decision: "genehmigen" | "ablehnen") {
    if (decision === "genehmigen") {
      void decideFerien(f.id, "genehmigen");
      return;
    }
    setBegruendung("");
    setAblehnen(f);
  }

  async function ablehnenSenden() {
    if (!ablehnen) return;
    const note = begruendung.trim();
    if (!note) {
      toast.error("Ablehnung ohne Begründung nicht möglich");
      return;
    }
    const ok = await decideFerien(ablehnen.id, "ablehnen", note);
    if (ok) setAblehnen(null);
  }

  async function decideFerien(id: string, decision: "genehmigen" | "ablehnen", note = ""): Promise<boolean> {
    setDecidingId(id + ":" + decision);
    try {
      const res = await fetch(`/api/time-off/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note || undefined }),
      });
      const j = (await res.json()) as { success: boolean; error?: string };
      if (!j.success) {
        toast.error(j.error || "Entscheidung konnte nicht gespeichert werden");
        return false;
      }
      toast.success(decision === "genehmigen" ? "Antrag genehmigt" : "Antrag abgelehnt");
      // Roter Punkt bei «Anträge» (use-nav-counts) im eigenen Tab sofort
      // nachziehen, ohne auf das Realtime-Event (Migration 316) zu warten.
      window.dispatchEvent(new Event("time_off:invalidate"));
      await load();
      return true;
    } catch {
      toast.error("Netzwerkfehler");
      return false;
    } finally {
      setDecidingId(null);
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        {[3, 5].map((n, b) => (
          <div key={b} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <div className="space-y-px overflow-hidden rounded-xl border border-border bg-card">
              {Array.from({ length: n }).map((_, i) => <Skeleton key={i} className="h-[52px] rounded-none" />)}
            </div>
          </div>
        ))}
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
  const shownActions = allActions.slice(0, 10); // tz-ok Array: die neuesten 10 Aktionen, kein Datum

  const ferienById = new Map(data.ferienAntraege.map((f) => [f.id, f]));
  const stempelById = new Map(data.stempelAntraege.map((s) => [s.id, s]));
  const ticketById = new Map(data.andereTickets.map((t) => [t.id, t]));

  // «Alle …»-Links unter der gekuerzten Liste.
  const gekuerzt = totalActions > shownActions.length;
  const ticketAnzahl = data.stempelAntraege.length + data.andereTickets.length;
  const zeigeAlleFerien = gekuerzt && data.ferienAntraege.length > 3;
  const zeigeAlleTickets = gekuerzt && ticketAnzahl > 3 && ticketsHref !== null;

  return (
    <div className="space-y-6">
      {/* ----------------- Aktions-Liste ----------------- */}
      <Abschnitt titel="Zu bearbeiten" anzahl={totalActions} amber>
        {totalActions === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card">
            <EmptyState
              icon={Inbox}
              title="Keine offenen Anträge"
              description="Alle Abwesenheiten und Tickets sind bearbeitet."
            />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border/60">
            {shownActions.map((a) => {
              if (a.kind === "ferien") {
                const f = ferienById.get(a.id)!;
                return (
                  <FerienZeile
                    key={"f-" + f.id}
                    f={f}
                    decidingId={decidingId}
                    onDecide={(d) => onDecide(f, d)}
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
            {(zeigeAlleFerien || zeigeAlleTickets) && (
              <div className="px-4 py-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                {zeigeAlleFerien && (
                  <TextLink href="/ferien">Alle {data.ferienAntraege.length} Abwesenheits-Anträge</TextLink>
                )}
                {zeigeAlleTickets && ticketsHref && (
                  <TextLink href={ticketsHref}>Alle Tickets ({ticketAnzahl})</TextLink>
                )}
              </div>
            )}
          </div>
        )}
      </Abschnitt>

      {/* ----------------- Mitarbeiter-Ampel ----------------- */}
      <Abschnitt titel="Mitarbeiter" anzahl={data.mitarbeiter.length}>
        {data.mitarbeiter.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card">
            <EmptyState
              icon={Users}
              title="Keine aktiven Techniker"
              description="Sobald Techniker aktiviert sind, erscheinen sie hier."
            />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border/60">
            {data.mitarbeiter.map((m) => (
              <MitarbeiterZeile key={m.id} m={m} href={stempelzeitenHref} />
            ))}
          </div>
        )}
      </Abschnitt>

      {/* Ablehnen — Begruendung ist Pflicht (Modal wie auf /ferien). */}
      <Modal
        open={ablehnen !== null}
        onClose={() => setAblehnen(null)}
        title="Antrag ablehnen"
        icon={<X className="h-5 w-5 text-red-500" />}
        size="md"
      >
        {ablehnen && (
          <div className="space-y-3">
            <div className="text-sm rounded-lg bg-muted/40 px-3 py-2">
              <p className="font-medium">{ablehnen.user_name}</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                {TIME_OFF_LABEL[ablehnen.type] ?? ablehnen.type} · {fmtDurRange(ablehnen.start_date, ablehnen.end_date)}
              </p>
              {ablehnen.note && <p className="text-xs mt-1 italic">&bdquo;{ablehnen.note}&ldquo;</p>}
            </div>
            <div>
              <label htmlFor="freigaben-begruendung" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Begründung (Pflicht)
              </label>
              <textarea
                id="freigaben-begruendung"
                value={begruendung}
                onChange={(e) => setBegruendung(e.target.value.slice(0, 500))}
                placeholder="Warum wird abgelehnt?"
                rows={3}
                maxLength={500}
                autoFocus
                className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-input bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => setAblehnen(null)} className="kasten kasten-muted flex-1">
                Abbrechen
              </button>
              <button
                type="button"
                onClick={() => void ablehnenSenden()}
                disabled={decidingId !== null || !begruendung.trim()}
                className="kasten kasten-red flex-1"
              >
                {decidingId === ablehnen.id + ":ablehnen"
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <X className="h-3.5 w-3.5" />}
                Ablehnen
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Abschnitt-Kopf ausserhalb der Karte — gleiche Form wie die Sektionen auf /ferien. */
function Abschnitt({ titel, anzahl, amber = false, children }: {
  titel: string;
  anzahl: number;
  amber?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{titel}</h2>
        {anzahl > 0 && (
          <span
            className={`text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full ${
              amber
                ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200"
                : "text-muted-foreground/70 bg-muted/60"
            }`}
          >
            {anzahl}
          </span>
        )}
      </div>
      {children}
    </section>
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
  onDecide: (decision: "genehmigen" | "ablehnen") => void;
}) {
  const genPending = decidingId === f.id + ":genehmigen";
  const abPending = decidingId === f.id + ":ablehnen";
  const anyPending = genPending || abPending;

  return (
    <div className="row-hover [--row-hover-x:0.5rem] flex flex-wrap items-center gap-3 px-4 py-2.5">
      <span className={`shrink-0 h-7 w-7 rounded-md inline-flex items-center justify-center ${TIME_OFF_FARBE[f.type] ?? TIME_OFF_FARBE.frei}`}>
        <Palmtree className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          <span className="font-medium">{f.user_name}</span>
          <span className="text-muted-foreground"> · {TIME_OFF_LABEL[f.type] ?? f.type} · {fmtDurRange(f.start_date, f.end_date)}</span>
        </div>
        {f.note && (
          <div className="text-[11px] italic text-muted-foreground truncate mt-0.5">„{f.note}"</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={() => onDecide("genehmigen")}
          disabled={anyPending}
          className="kasten kasten-green"
          data-tooltip="Antrag genehmigen"
        >
          {genPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Genehmigen
        </button>
        <button
          type="button"
          onClick={() => onDecide("ablehnen")}
          disabled={anyPending}
          className="kasten kasten-red"
          data-tooltip="Antrag ablehnen (Begründung Pflicht)"
        >
          {abPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Ablehnen
        </button>
      </div>
    </div>
  );
}

function StempelZeile({ s }: { s: StempelAntrag }) {
  return (
    <PrefetchLink href={`/tickets/${s.id}`} className="row-hover [--row-hover-x:0.5rem] flex items-center gap-3 px-4 py-2.5">
      <span className="shrink-0 h-7 w-7 rounded-md text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-500/15 inline-flex items-center justify-center">
        <Clock className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          <span className="font-mono text-[11px] font-semibold text-muted-foreground">#{s.ticket_number}</span>
          <span className="text-muted-foreground"> · {s.user_name} · </span>
          <span className="font-medium">{s.title}</span>
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5">
          Stempel-Änderung · {fmtDateTime(s.created_at)}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </PrefetchLink>
  );
}

function TicketZeile({ t }: { t: AndererTicket }) {
  const meta = TICKET_TYPE_META[t.type] ?? { label: t.type, icon: TicketCheck, className: "text-muted-foreground bg-muted" };
  const Icon = meta.icon;
  return (
    <PrefetchLink href={`/tickets/${t.id}`} className="row-hover [--row-hover-x:0.5rem] flex items-center gap-3 px-4 py-2.5">
      <span className={`shrink-0 h-7 w-7 rounded-md inline-flex items-center justify-center ${meta.className}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">
          <span className="font-mono text-[11px] font-semibold text-muted-foreground">#{t.ticket_number}</span>
          <span className="text-muted-foreground"> · {t.user_name} · </span>
          <span className="font-medium">{t.title}</span>
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5">
          {meta.label} · {fmtDateTime(t.created_at)}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </PrefetchLink>
  );
}

/** Zeile verlinkt auf /stempelzeiten, wenn die Rolle die Seite sehen darf
 *  (href gesetzt) — sonst reine Anzeige ohne Pfeil. */
function MitarbeiterZeile({
  m, href,
}: {
  m: MitarbeiterAmpel;
  href: string | null;
}) {
  const inhalt = (
    <>
      <PersonAvatar name={m.full_name} size="md" tooltip="" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium truncate">{m.full_name}</span>
          {m.is_active_stamped && m.active_since_iso && (
            <span
              className={`${PILLE} bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300`}
              data-tooltip={`Eingestempelt seit ${new Date(m.active_since_iso).toLocaleTimeString("de-CH", { timeZone: ZRH_TZ, hour: "2-digit", minute: "2-digit" })}`}
            >
              <CircleDot className="h-2.5 w-2.5" />
              {fmtActiveSince(m.active_since_iso)}
            </span>
          )}
          {m.current_absence && (
            <span className={`${PILLE} bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300`}>
              {TIME_OFF_LABEL[m.current_absence.type] ?? m.current_absence.type} bis {fmtDateShort(m.current_absence.end_date)}
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground truncate mt-0.5">
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
    </>
  );

  if (!href) {
    return <div className="w-full flex items-center gap-3 px-4 py-2.5">{inhalt}</div>;
  }
  return (
    <PrefetchLink
      href={href}
      data-tooltip="Stempelzeiten öffnen"
      className="row-hover [--row-hover-x:0.5rem] w-full flex items-center gap-3 px-4 py-2.5 text-left"
    >
      {inhalt}
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </PrefetchLink>
  );
}
