"use client";

/**
 * Einstellungen-Page — 2 Top-Tabs (Firmenportal / Partnerportal) mit
 * jeweils eigenen Sub-Sektionen. Restauriert nach kurzem Ausflug in eine
 * flache 5-Tab-Struktur — Leo will die zwei Portale wieder klar getrennt
 * haben, weil sich hinter „Firmenportal" und „Partnerportal" zwei
 * fachlich getrennte Welten verbergen (Firma-Mitarbeiter vs Location-
 * partner mit eigenem Modul-/Rollen-Katalog).
 *
 * Struktur:
 *   Firmenportal    → Firma / Team / Rollen / Aktivität / Integrationen
 *   Partnerportal   → Partner / Rollen / Anfrage-Formular / Aktivität
 *
 * Non-Admin sieht nur „Integrationen" (dort haengt sein persoenliches
 * Bexio-/Kalender-Setup) und wird beim Landen dorthin umgeleitet — kein
 * Portal-Switcher, damit er nicht in leere Sub-Tabs klickt.
 *
 * URL-Persistenz via ?tab=... (history.replaceState). Legacy-Tabkeys aus
 * der kurzen Flach-Aera werden auf die passenden Portal-Sub-Tabs
 * gemappt, damit Deep-Links (Bexio-Callback, /partner-Redirect,
 * interne Hinweise) weiter funktionieren.
 *
 * Nav-Muster:
 *   - Top-Tabs (Portal-Umschalter) = TabsNav (Underline, border-red-500) —
 *     kanonisches Nav-Tab-Muster app-weit.
 *   - Sub-Tabs (innerhalb eines Portals) = kasten-Toggle (kasten-active /
 *     kasten-toggle-off) — Filter-Semantik (gleiche Portal-Welt, andere
 *     Sektion), passt zu Regeln aus TabsNav-Kommentar.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { usePermissions } from "@/lib/use-permissions";
import { Plug, Users, Shield, Activity, Building2, Handshake, FileText } from "lucide-react";
import { BuildInfoBadge } from "@/components/einstellungen/build-info-badge";
import { TabsNav } from "@/components/ui/tabs-nav";
import { Skeleton } from "@/components/ui/skeleton";

// Tab-Inhalte via next/dynamic (Bundle-Split): vorher lagen alle 8 Tabs
// (~150 KB+ Quelle inkl. VisualBuilder-Kette des Partner-Formulars) in
// EINEM Chunk, obwohl immer nur genau ein Tab rendert. Jetzt laedt jeder
// Tab seinen Code erst beim Aktivieren; das Skeleton als loading-Fallback
// gibt sofortiges Feedback beim ersten Tab-Wechsel (CLAUDE.md §7).
// ssr:false ist ok — die Page ist eine reine Client-Component.
const tabLoading = () => (
  <div className="space-y-4">
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-64" />
  </div>
);
const dynOpts = { ssr: false, loading: tabLoading };
const FirmaTab = dynamic(() => import("@/components/einstellungen/firma-tab").then((m) => m.FirmaTab), dynOpts);
const TeamTab = dynamic(() => import("@/components/einstellungen/team-tab").then((m) => m.TeamTab), dynOpts);
const RollenTab = dynamic(() => import("@/components/einstellungen/rollen-tab").then((m) => m.RollenTab), dynOpts);
const PermissionAuditLogCard = dynamic(
  () => import("@/components/einstellungen/permission-audit-log").then((m) => m.PermissionAuditLogCard),
  dynOpts,
);
const AktivitaetTab = dynamic(() => import("@/components/einstellungen/aktivitaet-tab").then((m) => m.AktivitaetTab), dynOpts);
const IntegrationenTab = dynamic(
  () => import("@/components/einstellungen/integrationen-tab").then((m) => m.IntegrationenTab),
  dynOpts,
);
const PartnerFormTab = dynamic(() => import("@/components/einstellungen/partner-form-tab").then((m) => m.PartnerFormTab), dynOpts);
const PartnerView = dynamic(() => import("@/components/partner/partner-view").then((m) => m.PartnerView), dynOpts);

type Tab =
  | "firma"
  | "team"
  | "rollen"
  | "aktivitaet"
  | "integrationen"
  | "partner"
  | "partner-rollen"
  | "partner-form"
  | "partner-aktivitaet";
type Portal = "firma" | "partner";

const ALL_TABS: Tab[] = [
  "firma",
  "team",
  "rollen",
  "aktivitaet",
  "integrationen",
  "partner",
  "partner-rollen",
  "partner-form",
  "partner-aktivitaet",
];

// Welcher Sub-Tab gehoert welcher Portal-Gruppe. Beim Top-Tab-Wechsel
// springen wir auf den ersten Sub-Tab dieser Gruppe (siehe selectPortal).
const PORTAL_OF: Record<Tab, Portal> = {
  firma: "firma",
  team: "firma",
  rollen: "firma",
  aktivitaet: "firma",
  integrationen: "firma",
  partner: "partner",
  "partner-rollen": "partner",
  "partner-form": "partner",
  "partner-aktivitaet": "partner",
};

// Legacy-Mapping: alte flache Tabkeys → neue Portal-Sub-Tabkeys. Deckt
// bestehende Deep-Links ab (Bexio-Callback, /partner-Redirect, interne
// Hinweise „nachpflegen unter Einstellungen → Team").
const LEGACY_TAB_MAP: Record<string, Tab> = {
  "firma-stammdaten": "firma",
  "team-rollen": "team",
  "anfrage-form": "partner-form",
};

function resolveTab(raw: string | null): Tab | null {
  if (!raw) return null;
  if ((ALL_TABS as string[]).includes(raw)) return raw as Tab;
  return LEGACY_TAB_MAP[raw] ?? null;
}

export default function EinstellungenPage() {
  const searchParams = useSearchParams();
  const urlTab = resolveTab(searchParams.get("tab"));
  // Default = "firma" (erster Admin-Sub-Tab im Firmenportal). Non-Admin
  // wird via useEffect auf „integrationen" umgeleitet sobald der Admin-
  // Status geladen ist.
  const [tab, setTab] = useState<Tab>(urlTab ?? "firma");
  // Role via zentralem Permissions-Provider — vermeidet den doppelten
  // profiles-Roundtrip beim Seitenwechsel und teilt die 'admin'-Definition
  // mit dem Rest der (app)/-Baume (hasPermission gated Admin ohnehin
  // durch, siehe permissions.ts:126).
  const { role, ready } = usePermissions();
  const isAdmin: boolean | null = ready ? role === "admin" : null;

  // Tab-Wechsel: state = sofortige UI-Quelle, URL parallel updaten via
  // History-API (Next.js router.replace triggerte in Next 16 unzuverlaessig
  // fuer reine Query-Aenderungen).
  function selectTab(t: Tab) {
    setTab(t);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", t);
      window.history.replaceState({}, "", url.toString());
    }
  }

  // Top-Tab-Wechsel → ersten Sub-Tab dieser Portal-Gruppe oeffnen.
  function selectPortal(p: Portal) {
    if (PORTAL_OF[tab] === p) return;
    selectTab(p === "firma" ? "firma" : "partner");
  }

  const activePortal: Portal = PORTAL_OF[tab];

  // Non-Admin auf einem Admin-only-Tab → automatisch Integrationen.
  // Redirect erst wenn der Rolle-State fertig geladen ist (isAdmin !== null),
  // sonst wuerde der Non-Admin-Zweig faelschlicherweise fuer eine Millisekunde
  // waehrend usePermissions().ready===false triggern.
  useEffect(() => {
    if (isAdmin === false && tab !== "integrationen") {
      selectTab("integrationen");
    }
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Firmenportal-Sub-Tabs (admin sieht alles, Non-Admin nur Integrationen —
  // siehe useEffect-Redirect oben).
  const firmaTabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    ...(isAdmin
      ? [
          { key: "firma" as Tab, label: "Firma", icon: <Building2 className="h-4 w-4" /> },
          { key: "team" as Tab, label: "Team", icon: <Users className="h-4 w-4" /> },
          { key: "rollen" as Tab, label: "Rollen", icon: <Shield className="h-4 w-4" /> },
          { key: "aktivitaet" as Tab, label: "Aktivität", icon: <Activity className="h-4 w-4" /> },
        ]
      : []),
    { key: "integrationen", label: "Integrationen", icon: <Plug className="h-4 w-4" /> },
  ];

  // Partnerportal-Sub-Tabs — Partner-Benutzerliste, Rollen, Anfrage-Form,
  // Aktivitaet. Nur fuer Admin sichtbar.
  const partnerTabs: { key: Tab; label: string; icon: React.ReactNode }[] = isAdmin
    ? [
        { key: "partner" as Tab, label: "Partner", icon: <Building2 className="h-4 w-4" /> },
        { key: "partner-rollen" as Tab, label: "Rollen", icon: <Shield className="h-4 w-4" /> },
        { key: "partner-form" as Tab, label: "Anfrage-Formular", icon: <FileText className="h-4 w-4" /> },
        { key: "partner-aktivitaet" as Tab, label: "Aktivität", icon: <Activity className="h-4 w-4" /> },
      ]
    : [];

  const subTabs = activePortal === "firma" ? firmaTabs : partnerTabs;

  const portalTabs = [
    { key: "firma", label: "Firmenportal", icon: <Building2 className="h-4 w-4" /> },
    { key: "partner", label: "Partnerportal", icon: <Handshake className="h-4 w-4" /> },
  ];

  // Solange Rolle nicht ready ist rendern wir NICHTS — sonst blitzt fuer den
  // Non-Admin kurz der leere „firma"-Tab-Content auf, bevor der useEffect
  // oben ihn auf „integrationen" umleitet.
  if (!ready) return null;

  return (
    <div className="space-y-8">
      {/* Header — konsistent mit /auftraege etc. (h1 + Subtitle-Spacer),
          rechts oben das Build-Info-Fun-Fact-Widget. */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
          <p className="text-sm text-muted-foreground mt-1" aria-hidden="true">&nbsp;</p>
        </div>
        <BuildInfoBadge />
      </div>

      {/* Top-Tabs (Portal-Umschalter, Underline via TabsNav) + Sub-Tabs
          (kasten-Toggle) — bilden zusammen die zwei-Ebenen-Navigation.
          Non-Admin sieht keine Portal-Umschalter (nur Integrationen im
          Firmenportal). */}
      <div>
        {isAdmin && (
          <TabsNav
            tabs={portalTabs}
            active={activePortal}
            onChange={(k) => selectPortal(k as Portal)}
            ariaLabel="Portal-Umschalter"
          />
        )}

        <div className="flex flex-wrap gap-2 mt-10">
          {subTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              className={tab === t.key ? "kasten-active" : "kasten-toggle-off"}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "firma" && isAdmin && <FirmaTab isAdmin={isAdmin} />}

      {tab === "team" && isAdmin && <TeamTab />}

      {tab === "rollen" && isAdmin && (
        <div className="space-y-6">
          <RollenTab scope="firma" />
          <PermissionAuditLogCard />
        </div>
      )}

      {tab === "aktivitaet" && isAdmin && <AktivitaetTab scope="firma" />}

      {tab === "integrationen" && (
        <div className="space-y-6">
          <IntegrationenTab />
        </div>
      )}

      {tab === "partner" && isAdmin && <PartnerView embedded />}

      {tab === "partner-rollen" && isAdmin && <RollenTab scope="partner" />}

      {tab === "partner-form" && isAdmin && <PartnerFormTab />}

      {tab === "partner-aktivitaet" && isAdmin && <AktivitaetTab scope="partner" />}
    </div>
  );
}
