"use client";

/**
 * Dashboard — dynamische, User-anpassbare Startseite.
 *
 * Rendering-Modell:
 *   Der Server liefert in /api/dashboard eine `widgets`-Liste (WidgetId[]) in
 *   Anzeige-Reihenfolge. Wir mappen jede ID auf einen React-Renderer
 *   (WIDGET_RENDERERS) und legen sie in ein Grid mit vorgegebenen Column-
 *   Spans (WIDGET_SPAN). Rolle-basierte hardcoded Layouts gibt es nicht mehr —
 *   admin / techniker / partner sind einfach unterschiedliche `widgets`-Sets.
 *
 * Anpassbarkeit:
 *   Zahnrad-Icon oben rechts oeffnet `DashboardPreferencesModal`
 *   (Sichtbarkeit + Reihenfolge, persistent in user_dashboard_overrides).
 *   Nach Save/Reset triggern wir einen Refetch von /api/dashboard.
 *
 * Payloads:
 *   `admin` und `ma` sind optional — der Server laedt sie nur wenn
 *   mindestens ein sichtbares Widget den Loader braucht. Wir uebergeben
 *   sie via Kontext-Objekt an die Renderer.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, ArrowRight, Briefcase, CalendarDays, ClipboardList,
  Clock, Handshake, PlaneTakeoff, Receipt, Settings2,
  Ticket as TicketIcon, Users, Wallet,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { JobNumber } from "@/components/job-number";
import { localHour } from "@/lib/swiss-time";
import { AnwesenheitskalenderCard } from "@/components/dashboard/anwesenheit-card";
import { OverdueJobsCard, type OverdueJobItem } from "@/components/dashboard/overdue-jobs-card";
import { DashboardPreferencesModal } from "@/components/dashboard/dashboard-preferences-modal";
import { widgetEffectiveSpanClass } from "@/lib/dashboard-widgets";

// ---------------------------------------------------------------------------
// Payload-Typen (Spiegel zu /api/dashboard)
// ---------------------------------------------------------------------------

interface NaechsterEinsatz {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  job_number: number | null;
  job_title: string | null;
  customer_name: string | null;
}

interface MaData {
  monat_stunden: number;
  ist_lohn_chf: number;
  wage_exempt: boolean;
  hourly_wage_chf: number | null;
  prognose_stunden: number;
  prognose_lohn_chf: number;
  naechster_einsatz: NaechsterEinsatz | null;
}

interface AdminData {
  kpi: {
    offene_auftraege: number;
    geplante_termine_woche: number;
    nicht_abgerechnet: number;
  };
  zu_erledigen: {
    ferien_pending: number;
    ueberfaellige_auftraege: number;
    neue_belege: number;
    offene_tickets: number;
  };
  team_status: {
    eingestempelt: number;
    in_ferien_heute: number;
    // 'all' = firm-weit (Admin/scope='all'), 'team' = Team-Leiter-Sicht,
    // 'self' = nur eigene Datensaetze (Sicherheitsnetz). Wird fuer den
    // Widget-Titel genutzt ("Team-Status" vs "Mein Team").
    scope?: "self" | "team" | "all";
    members?: {
      id: string;
      full_name: string;
      status: "eingestempelt" | "abwesend" | "offline";
      clock_in: string | null;
      context_label: string | null;
      abwesenheit_typ: string | null;
    }[];
  };
  overdue_jobs: {
    count: number;
    items: OverdueJobItem[];
  };
}

interface WidgetCatalogEntry {
  id: string;
  title: string;
  requires: string[];
}

interface DashboardResponse {
  success: true;
  role: "admin" | "techniker" | "partner" | string;
  first_name: string;
  subtitle: string;
  widgets: string[];
  widget_catalog: WidgetCatalogEntry[];
  /** User-Overrides der Widget-Breiten (col-span 4/6/8/12). Fehlende IDs
   *  fallen im Renderer auf widgetDefaultSpan(id) zurueck. */
  widget_spans?: Record<string, number>;
  admin?: AdminData;
  ma?: MaData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function greetingForHour(h: number): string {
  if (h < 12) return "Guten Morgen";
  if (h < 17) return "Guten Tag";
  return "Guten Abend";
}

function fmtChf(v: number): string {
  return new Intl.NumberFormat("de-CH", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(v));
}

function fmtHours(h: number): string {
  const rounded = Math.round(h * 10) / 10;
  return `${rounded.toLocaleString("de-CH", { minimumFractionDigits: rounded % 1 === 0 ? 0 : 1, maximumFractionDigits: 1 })} h`;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Widget-Layout
// ---------------------------------------------------------------------------
// Column-Spans pro Widget kommen aus src/lib/dashboard-widgets.ts (Single
// Source of Truth — auch das Preferences-Modal liest von dort). Fruehere
// PREVIEW_SPAN-Duplikation dort ist eliminiert.

interface RenderContext {
  admin: AdminData | null;
  ma: MaData | null;
}

/** Widget-Renderer-Registry. Getrennt von der Config-Registry
 *  (src/lib/dashboard-widgets.ts) weil dort keine React-Renderer landen
 *  duerfen — die Config wird server-side gelesen. */
const WIDGET_RENDERERS: Record<string, (ctx: RenderContext) => React.ReactNode> = {
  "kpi-offene-auftraege": ({ admin }) =>
    admin && (
      <KpiCard
        icon={<Briefcase className="h-3.5 w-3.5" />}
        label="Offene Aufträge"
        value={admin.kpi?.offene_auftraege ?? 0}
        href="/auftraege?from=dashboard"
      />
    ),
  "kpi-termine-woche": ({ admin }) =>
    admin && (
      <KpiCard
        icon={<CalendarDays className="h-3.5 w-3.5" />}
        label="Termine nächste 7 Tage"
        value={admin.kpi?.geplante_termine_woche ?? 0}
        href="/kalender?from=dashboard"
      />
    ),
  "kpi-nicht-abgerechnet": ({ admin }) =>
    admin && (
      <KpiCard
        icon={<Receipt className="h-3.5 w-3.5" />}
        label="Nicht abgerechnet"
        value={admin.kpi?.nicht_abgerechnet ?? 0}
        href="/abrechnung?from=dashboard"
      />
    ),
  "overdue-jobs": ({ admin }) =>
    admin && (
      <OverdueJobsCard
        count={admin.overdue_jobs?.count ?? 0}
        items={admin.overdue_jobs?.items ?? []}
      />
    ),
  "zu-erledigen": ({ admin }) =>
    admin && (
      <ZuErledigenCard
        data={admin.zu_erledigen ?? { ferien_pending: 0, ueberfaellige_auftraege: 0, neue_belege: 0, offene_tickets: 0 }}
      />
    ),
  "team-status": ({ admin }) =>
    admin && (
      <TeamStatusCard
        data={admin.team_status ?? { eingestempelt: 0, in_ferien_heute: 0, scope: "all" }}
      />
    ),
  "anwesenheitskalender": () => <AnwesenheitskalenderCard />,
  "ma-monat-stunden": ({ ma }) => ma && <MaMonatStundenCard ma={ma} />,
  "ma-prognose": ({ ma }) => ma && <MaPrognoseCard ma={ma} />,
  "ma-naechster-einsatz": ({ ma }) => ma && <NaechsterEinsatzCard einsatz={ma.naechster_einsatz} />,
  "partner-willkommen": () => <PartnerWillkommenCard />,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [settingsHover, setSettingsHover] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch("/api/dashboard", { credentials: "include", cache: "no-store" });
        // Bei HTML-Fehlerseite (500) wuerde res.json() sonst mit unpassendem
        // SyntaxError fliegen — Status vorne wegfangen liefert einen echten Grund.
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const json = (await res.json()) as Partial<DashboardResponse> & { error?: string };
        if (cancelled) return;
        if (!json || typeof json !== "object" || !("success" in json) || !json.success) {
          setError((json as { error?: string })?.error ?? "Laden fehlgeschlagen");
        } else {
          setData(json as DashboardResponse);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Netzwerk-Fehler");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  // localHour = Zurich-Stunde via Intl (DST-safe). Browser-Stunde (getHours)
  // waere abhaengig vom Endgeraet-TZ und wuerde in fremden Zeitzonen "Guten
  // Morgen" um Zurich-Mitternacht zeigen.
  const greeting = greetingForHour(localHour(new Date()));
  const name = data?.first_name?.trim() ?? "";

  if (loading) {
    return (
      <div className="page-enter space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-enter space-y-4">
        <h1 className="font-heading text-2xl font-semibold">Dashboard</h1>
        <div className="rounded-xl border bg-card p-4 flex items-start gap-3 text-sm">
          <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Dashboard konnte nicht geladen werden</p>
            <p className="text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const ctx: RenderContext = { admin: data?.admin ?? null, ma: data?.ma ?? null };
  const widgets = data?.widgets ?? [];
  const catalog = data?.widget_catalog ?? [];
  const widgetSpans = data?.widget_spans ?? {};
  // Subtitle kommt vom Server — die Rollen-Semantik lebt dort (roles-Tabelle,
  // frei-definierbare Slugs), nicht in einem hardcoded Client-Match.
  const subtitle = data?.subtitle ?? "";

  return (
    <div className="page-enter space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <h1 className="font-heading text-2xl font-semibold truncate">
            {greeting}{name ? `, ${name}` : ""}
          </h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={() => setPrefsOpen(true)}
          onMouseEnter={() => setSettingsHover(true)}
          onMouseLeave={() => setSettingsHover(false)}
          data-tooltip="Dashboard anpassen"
          aria-label="Dashboard anpassen"
          className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-lg border transition-colors"
          style={{
            color: settingsHover ? "var(--foreground)" : "var(--muted-foreground)",
            backgroundColor: settingsHover
              ? "color-mix(in oklab, var(--foreground) 5%, transparent)"
              : "transparent",
            borderColor: "var(--border)",
          }}
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </header>

      {widgets.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
          Alle Widgets sind ausgeblendet. Klick oben rechts auf das Zahnrad, um wieder Widgets einzublenden.
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {widgets.map((id) => {
            const render = WIDGET_RENDERERS[id];
            const node = render?.(ctx);
            if (!node) return null;
            return (
              <div key={id} className={widgetEffectiveSpanClass(id, widgetSpans[id])}>
                {node}
              </div>
            );
          })}
        </div>
      )}

      <DashboardPreferencesModal
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        onSaved={() => setReloadKey((k) => k + 1)}
        catalog={catalog}
        visibleIds={widgets}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget-Bausteine
// ---------------------------------------------------------------------------

function KpiCard({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border bg-card p-4 hover:border-accent transition-colors block h-full"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <div className="mt-2 font-heading text-3xl font-semibold tabular-nums">{value}</div>
    </Link>
  );
}

function ZuErledigenCard({ data }: { data: AdminData["zu_erledigen"] }) {
  return (
    <section className="rounded-xl border bg-card p-4 h-full">
      <h2 className="font-heading text-base font-semibold flex items-center gap-2 mb-3">
        <ClipboardList className="h-4 w-4 text-accent" /> Zu erledigen
      </h2>
      <div className="divide-y">
        <TodoRow
          icon={<PlaneTakeoff className="h-4 w-4" />}
          label="Abwesenheits-Anträge"
          count={data.ferien_pending}
          href="/hr?tab=anfragen&from=dashboard"
        />
        <TodoRow
          icon={<AlertCircle className="h-4 w-4" />}
          label="Überfällige Aufträge"
          count={data.ueberfaellige_auftraege}
          href="/auftraege?from=dashboard"
          urgent={data.ueberfaellige_auftraege > 0}
        />
        <TodoRow
          icon={<Receipt className="h-4 w-4" />}
          label="Neue Belege"
          count={data.neue_belege}
          href="/abrechnung?from=dashboard"
        />
        <TodoRow
          icon={<TicketIcon className="h-4 w-4" />}
          label="Offene Tickets"
          count={data.offene_tickets}
          href="/tickets?from=dashboard"
        />
      </div>
    </section>
  );
}

// Anzeige-Labels der Abwesenheits-Typen (time_off.type).
const ABWESENHEIT_LABEL: Record<string, string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Kompensation",
  frei: "Frei",
  militaer: "Militär",
};

function TeamStatusCard({ data }: { data: AdminData["team_status"] }) {
  // Team-Leiter-Sicht: der Titel signalisiert die verengte Datengrundlage —
  // "Mein Team" statt "Team-Status". Firm-weite Sicht (Admin/scope='all')
  // bleibt beim generischen Titel. Migration 208 fuehrte roles.scope ein.
  const title = data.scope === "team" ? "Mein Team" : "Team-Status";
  const members = data.members ?? [];
  return (
    <section className="rounded-xl border bg-card p-4 h-full flex flex-col">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h2 className="font-heading text-base font-semibold flex items-center gap-2">
          <Users className="h-4 w-4 text-accent" /> {title}
        </h2>
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
          {data.eingestempelt} eingestempelt · {data.in_ferien_heute} abwesend
        </span>
      </div>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">Keine Mitarbeiter zugeteilt.</p>
      ) : (
        // §14: lange Listen INTERN scrollen — das Widget waechst nicht endlos.
        <div className="divide-y overflow-y-auto flex-1 min-h-0" style={{ maxHeight: 320 }}>
          {members.map((m) => {
            const isIn = m.status === "eingestempelt";
            const isAway = m.status === "abwesend";
            const seit = m.clock_in
              ? new Date(m.clock_in).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })
              : null;
            return (
              <Link
                key={m.id}
                href={`/stempelzeiten?user=${m.id}&from=dashboard`}
                className={`flex items-center gap-2.5 py-2 px-1 hover:bg-muted/40 transition-colors ${
                  m.status === "offline" ? "opacity-60" : ""
                }`}
              >
                {/* Status-Punkt: gruen pulsierend = eingestempelt, amber = abwesend, grau = offline */}
                <span className="relative flex h-2 w-2 shrink-0">
                  {isIn && (
                    <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full opacity-50" style={{ backgroundColor: "#22c55e" }} />
                  )}
                  <span
                    className="relative inline-flex h-2 w-2 rounded-full"
                    style={{ backgroundColor: isIn ? "#22c55e" : isAway ? "#f59e0b" : "var(--border)" }}
                  />
                </span>
                <span className="text-sm font-medium truncate shrink-0 max-w-[40%]">{m.full_name}</span>
                <span className="text-xs text-muted-foreground truncate flex-1 text-right tabular-nums">
                  {isIn
                    ? <>seit {seit}{m.context_label ? ` · ${m.context_label}` : ""}</>
                    : isAway
                    ? (ABWESENHEIT_LABEL[m.abwesenheit_typ ?? ""] ?? "Abwesend")
                    : "—"}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TodoRow({
  icon,
  label,
  count,
  href,
  urgent = false,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  href: string;
  urgent?: boolean;
}) {
  const badge = count === 0 ? (
    <span className="text-xs text-muted-foreground/70">0</span>
  ) : (
    <span
      className={`inline-flex items-center justify-center min-w-[1.75rem] h-6 px-2 rounded-full text-xs font-semibold tabular-nums ${
        urgent
          ? "bg-red-500/15 text-red-700 dark:text-red-300"
          : "bg-foreground/10 text-foreground/80 dark:bg-foreground/15"
      }`}
    >
      {count}
    </span>
  );
  return (
    <Link
      href={href}
      className="flex items-center gap-3 py-2.5 text-sm hover:text-accent transition-colors"
    >
      <span className="text-muted-foreground/70">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge}
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/40" />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// MA-Widgets
// ---------------------------------------------------------------------------

function MaMonatStundenCard({ ma }: { ma: MaData }) {
  const monatLohnLabel = ma.wage_exempt
    ? "Kein Lohn hinterlegt"
    : ma.hourly_wage_chf == null
    ? "Kein Stundensatz hinterlegt"
    : `= CHF ${fmtChf(ma.ist_lohn_chf)} ausbezahlt`;
  return (
    <section className="rounded-xl border bg-card p-5 h-full">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <Clock className="h-3.5 w-3.5 text-accent" />
        Deine Stunden diesen Monat
      </div>
      <div className="mt-3 flex items-baseline gap-2 tabular-nums">
        <span className="font-heading text-5xl font-semibold leading-none">
          {ma.monat_stunden.toLocaleString("de-CH", { maximumFractionDigits: 1 })}
        </span>
        <span className="text-xl text-muted-foreground">h</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{monatLohnLabel}</p>
      <Link
        href="/stempelzeiten?from=dashboard"
        className="mt-3 inline-flex items-center gap-1 text-xs text-accent font-medium hover:underline"
      >
        Zu meinen Stempelzeiten <ArrowRight className="h-3 w-3" />
      </Link>
    </section>
  );
}

function MaPrognoseCard({ ma }: { ma: MaData }) {
  const prognoseLohnLabel = ma.wage_exempt
    ? "Kein Lohn hinterlegt"
    : ma.hourly_wage_chf == null
    ? "Kein Stundensatz hinterlegt"
    : `= CHF ${fmtChf(ma.prognose_lohn_chf)}`;
  const plannedHours = Math.max(0, ma.prognose_stunden - ma.monat_stunden);
  return (
    <section className="rounded-xl border bg-card p-5 h-full">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <Wallet className="h-3.5 w-3.5 text-accent" />
        Prognose Monatsende
      </div>
      <div className="mt-3 flex items-baseline gap-2 tabular-nums">
        <span className="font-heading text-5xl font-semibold leading-none">
          {ma.prognose_stunden.toLocaleString("de-CH", { maximumFractionDigits: 1 })}
        </span>
        <span className="text-xl text-muted-foreground">h</span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{prognoseLohnLabel}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        aktuell {fmtHours(ma.monat_stunden)} + geplant {fmtHours(plannedHours)}
      </p>
    </section>
  );
}

function NaechsterEinsatzCard({ einsatz }: { einsatz: NaechsterEinsatz | null }) {
  if (!einsatz) {
    return (
      <section className="rounded-xl border bg-card p-4 text-sm text-muted-foreground flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-muted-foreground/70" />
        Kein anstehender Einsatz.
      </section>
    );
  }
  return (
    <Link
      href="/kalender?from=dashboard"
      className="block rounded-xl border bg-card p-4 hover:border-accent transition-colors"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <CalendarDays className="h-3.5 w-3.5 text-accent" />
        Nächster Einsatz
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold tabular-nums">{fmtDateTime(einsatz.start_time)}</span>
        {einsatz.job_number != null && <JobNumber number={einsatz.job_number} />}
        <span className="text-sm text-muted-foreground truncate">
          {einsatz.customer_name ?? einsatz.job_title ?? einsatz.title}
        </span>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Partner-Widget
// ---------------------------------------------------------------------------

function PartnerWillkommenCard() {
  return (
    <section className="rounded-xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <Handshake className="h-5 w-5 text-accent shrink-0 mt-0.5" />
        <div>
          <h2 className="font-heading text-lg font-semibold">Willkommen im Partner-Portal</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Hier siehst du deine Anfragen und kannst sie beantworten.
          </p>
          <Link
            href="/partner/anfragen"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
          >
            Zu meinen Anfragen <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
