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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import {
  AlertCircle, ArrowRight, Briefcase, CalendarDays, ClipboardList,
  Clock, Handshake, Loader2, PlaneTakeoff, Receipt, Settings2,
  Ticket as TicketIcon, Users, Wallet,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { JobNumber } from "@/components/job-number";
import { localHour } from "@/lib/swiss-time";
import { createClient } from "@/lib/supabase/client";
import { AnwesenheitskalenderCard } from "@/components/dashboard/anwesenheit-card";
import { OverdueJobsCard, type OverdueJobItem } from "@/components/dashboard/overdue-jobs-card";
import { widgetEffectiveSpanClass } from "@/lib/dashboard-widgets";

// Konfigurator-Modal + @dnd-kit NUR bei Bedarf laden (Perf: das Modal ist
// ~50 KB Quelle und zieht @dnd-kit/core, gebraucht wird es aber erst nach
// Zahnrad-Klick). next/dynamic mit ssr:false haelt den Code aus dem
// Dashboard-Chunk; gemountet wird erst bei prefsOpen (siehe unten). Der
// loading-Fallback spiegelt den Modal-Backdrop (gleiche z-Indices wie
// ui/modal.tsx), damit der erste Zahnrad-Klick sofort sichtbares Feedback
// zeigt (§7) — danach ist der Chunk gecached und oeffnet instant.
const DashboardPreferencesModal = dynamic(
  () =>
    import("@/components/dashboard/dashboard-preferences-modal").then(
      (m) => m.DashboardPreferencesModal,
    ),
  {
    ssr: false,
    loading: () => (
      <>
        <div className="fixed inset-0 z-[1100] bg-black/60 backdrop-blur" />
        <div className="fixed inset-0 z-[1110] flex items-center justify-center p-4">
          <Loader2 className="h-6 w-6 animate-spin text-white" />
        </div>
      </>
    ),
  },
);

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
// Session-Cache (stale-while-revalidate)
// ---------------------------------------------------------------------------
// Perf: Frueher zeigte JEDER Dashboard-Besuch (Startseite!) erst das volle
// Skeleton und wartete den kompletten /api/dashboard-Roundtrip ab — auch
// 10 Sekunden nach dem letzten Besuch. Jetzt lebt die letzte Antwort in
// diesem Modul-Level-Cache: Beim naechsten Mount (Soft-Navigation zurueck
// aufs Dashboard) rendern wir SOFORT aus dem Cache (kein Skeleton) und
// revalidieren still im Hintergrund (Fetch laeuft immer, ersetzt die
// Anzeige bei Antwort). Das deckt zugleich das Navigations-Cache-Finding
// ab (Dashboard -> Auftrag -> Dashboard laedt nicht mehr sichtbar neu) —
// dieselbe SWR-Mechanik ist das Muster fuer weitere Listen-Seiten.
//
// Sicherheit: Logout/Login sind SOFT-Navigationen (router.push in
// (app)/layout.tsx handleSignOut bzw. login/page.tsx) — ein Modul-Cache
// wuerde einen User-Wechsel im selben Tab ueberleben und dem naechsten
// User kurz fremde Daten (inkl. MA-Lohn) zeigen. Deshalb haengt ein
// Auth-Watcher am Supabase-Singleton: SIGNED_OUT / Session weg / andere
// User-ID leert den Cache sofort (wirkt auch cross-tab, Supabase
// broadcastet Sign-Outs). sessionStorage wird bewusst NICHT genutzt — es
// wuerde den Logout ebenso ueberleben, haette aber keinen Clear-Hook.
// Server-seitig bleibt der Cache immer leer (geschrieben wird nur in
// Client-Effects) — kein Cross-Request-Leak im Node-Prozess.

let dashboardCache: { data: DashboardResponse; userId: string | null } | null = null;
// Letzte bekannte Auth-User-ID — taggt neue Cache-Eintraege, damit ein
// User-Wechsel im selben Tab erkannt wird. null = (noch) unbekannt.
let cacheUserId: string | null = null;
let authWatcherStarted = false;

function ensureCacheAuthWatcher() {
  if (authWatcherStarted || typeof window === "undefined") return;
  authWatcherStarted = true;
  createClient().auth.onAuthStateChange((event, session) => {
    const uid = session?.user?.id ?? null;
    if (event === "SIGNED_OUT" || uid === null) {
      // Konservativ: ohne Session nie gecachte Daten behalten (schlimmster
      // Fall eines Fehl-Clears ist das alte Verhalten: Skeleton + Fetch).
      dashboardCache = null;
      cacheUserId = null;
      return;
    }
    if (dashboardCache) {
      if (dashboardCache.userId === null) {
        // Cache wurde geschrieben bevor die erste Auth-Info da war.
        // /api/dashboard ist auth-gated — die Antwort gehoert diesem User.
        dashboardCache.userId = uid;
      } else if (dashboardCache.userId !== uid) {
        dashboardCache = null; // anderer User im selben Tab -> nie stale Fremd-Daten
      }
    }
    cacheUserId = uid;
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  // Lazy-Init aus dem Session-Cache: auf dem Server und beim allerersten
  // Client-Besuch ist der Cache leer (-> Skeleton, hydration-safe); bei
  // Soft-Navigation zurueck rendert der erste Frame sofort die Daten.
  const [data, setData] = useState<DashboardResponse | null>(() => dashboardCache?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => dashboardCache === null);
  // Spiegel von `data` fuer den Fetch-Fehlerpfad (dort entscheidet "haben
  // wir Stale-Daten?" zwischen Toast und Error-Screen, ohne data in die
  // Effect-Deps zu ziehen).
  const dataRef = useRef<DashboardResponse | null>(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const [prefsOpen, setPrefsOpen] = useState(false);
  // Gemessene Live-Hoehen der Widgets (px, Karten-Hoehe) — beim Oeffnen des
  // Konfigurators erhoben, damit dessen Vorschau echte Proportionen zeigt.
  const [liveHeights, setLiveHeights] = useState<Record<string, number>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [settingsHover, setSettingsHover] = useState(false);

  // Stale-while-revalidate: der Fetch laeuft bei JEDEM Mount und bei jedem
  // reloadKey-Bump (Konfigurator-Save) IMMER frisch gegen den Server
  // (cache: no-store) — gecachte Daten sind lediglich die Sofort-Anzeige,
  // bis die frische Antwort sie still ersetzt. Skeleton gibt es nur noch
  // beim allerersten Load ohne Cache (siehe Render-Guard unten).
  useEffect(() => {
    let cancelled = false;
    ensureCacheAuthWatcher();
    (async () => {
      try {
        const res = await fetch("/api/dashboard", { credentials: "include", cache: "no-store" });
        // Bei HTML-Fehlerseite (500) wuerde res.json() sonst mit unpassendem
        // SyntaxError fliegen — Status vorne wegfangen liefert einen echten Grund.
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const json = (await res.json()) as Partial<DashboardResponse> & { error?: string };
        if (cancelled) return;
        if (!json || typeof json !== "object" || !("success" in json) || !json.success) {
          throw new Error((json as { error?: string })?.error ?? "Laden fehlgeschlagen");
        }
        const fresh = json as DashboardResponse;
        setData(fresh);
        setError(null);
        dashboardCache = { data: fresh, userId: cacheUserId };
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Netzwerk-Fehler";
        if (dataRef.current) {
          // Stale-Daten stehen bereits — kein Error-Screen drueberlegen,
          // aber nie stiller Fehlschlag (§7): Toast.
          toast.error(`Dashboard konnte nicht aktualisiert werden: ${msg}`);
        } else {
          setError(msg);
        }
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

  // Skeleton nur beim Erst-Load ohne Session-Cache; mit Cache rendert die
  // Seite sofort die (Sekunden alten) Daten und aktualisiert still.
  if (loading && !data) {
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

  // Error-Screen nur wenn gar nichts anzeigbar ist — Revalidate-Fehler bei
  // vorhandenen Stale-Daten laufen als Toast (siehe Effect).
  if (error && !data) {
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
          onClick={() => {
            // Live-Hoehen der gerenderten Widgets messen (Karten-Hoehe ohne
            // den pb-4-Abstand) — der Konfigurator zeigt die Kacheln damit
            // in echten Proportionen (Preview = Endresultat).
            const m: Record<string, number> = {};
            document.querySelectorAll<HTMLElement>("[data-widget-id]").forEach((el) => {
              const id = el.dataset.widgetId;
              const inner = el.firstElementChild as HTMLElement | null;
              if (id && inner) m[id] = Math.max(0, inner.getBoundingClientRect().height - 16);
            });
            setLiveHeights(m);
            setPrefsOpen(true);
          }}
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
        // Masonry-Grid (Leo 2026-09-08: "mega viel weissraum nur weil der
        // dritte rechts so weit nach unten geht"): 1px-Zeilen ohne row-gap,
        // jede Zelle spannt exakt ihre Inhaltshoehe (MasonryCell misst per
        // ResizeObserver). CSS-Grid-Auto-Placement packt nachfolgende Karten
        // dann direkt unter kuerzere Nachbarn statt eine ganze Grid-Row auf
        // die hoechste Karte zu strecken. Der 16px-Abstand kommt als pb-4
        // im Mess-Wrapper (statt row-gap — so bleibt die Spannweite exakt).
        <div className="grid grid-cols-12 gap-x-4 auto-rows-[1px]">
          {widgets.map((id) => {
            const render = WIDGET_RENDERERS[id];
            const node = render?.(ctx);
            if (!node) return null;
            return (
              <MasonryCell key={id} widgetId={id} className={widgetEffectiveSpanClass(id, widgetSpans[id])}>
                {node}
              </MasonryCell>
            );
          })}
        </div>
      )}

      {/* Erst beim Zahnrad-Klick mounten — so laedt der dynamic()-Chunk
          (Modal + @dnd-kit) wirklich erst bei Bedarf. Das Modal selbst hat
          keine Exit-Animation (ui/modal.tsx rendert bei !open null),
          bedingtes Unmounten aendert also nichts am Verhalten. */}
      {prefsOpen && (
        <DashboardPreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          onSaved={() => setReloadKey((k) => k + 1)}
          catalog={catalog}
          visibleIds={widgets}
          liveHeights={liveHeights}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MasonryCell — Grid-Zelle die exakt ihre Inhaltshoehe spannt.
//
// Der Grid-Container nutzt auto-rows-[1px] OHNE row-gap; diese Zelle misst
// ihren Inhalt (ResizeObserver) und setzt gridRowEnd: span <hoehe_px>.
// Ergebnis: CSS-Auto-Placement packt nachfolgende Karten direkt unter
// kuerzere Nachbarn (Masonry) statt jede "Reihe" auf die hoechste Karte
// zu strecken. Der 16px-Abstand zwischen Karten steckt als pb-4 im
// Mess-Wrapper — dadurch bleibt die Spannweite pixel-exakt.
//
// h-full in den Widget-Karten ist hier wirkungslos (der Mess-Wrapper hat
// auto-Hoehe) — Karten sind inhalt-hoch, genau der Sinn der Uebung (§14:
// adaptive Layouts inhalt-getrieben, nicht zwang-gefuellt).
// ---------------------------------------------------------------------------

function MasonryCell({
  widgetId,
  className,
  children,
}: {
  widgetId: string;
  className: string;
  children: React.ReactNode;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const update = () => {
      const h = el.getBoundingClientRect().height;
      setSpan(Math.max(1, Math.ceil(h)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      className={className}
      data-widget-id={widgetId}
      style={span ? { gridRowEnd: `span ${span}` } : undefined}
    >
      <div ref={measureRef} className="pb-4">{children}</div>
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
