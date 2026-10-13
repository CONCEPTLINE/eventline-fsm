"use client";

/**
 * Einstellungen-Page — nur noch echte Konfiguration. 3 Top-Tabs
 * (Firmenportal / Partnerportal / Lieferantenportal) mit jeweils eigenen
 * Sub-Sektionen. Die zwei-Ebenen-Struktur bleibt, weil sich hinter den
 * Portalen fachlich getrennte Welten verbergen (Firma-Mitarbeiter vs
 * Location-Partner vs Lieferanten mit eigenem Rollen-Katalog).
 *
 * Struktur:
 *   Firmenportal      → Firma / Rollen / Integrationen
 *   Partnerportal     → Zugänge / Rollen / Anfrage-Formular
 *   Lieferantenportal → Zugänge (inkl. Kataloge) / Rollen
 * Partner- und Lieferantenportal sind eigenstaendig (nichts mit dem
 * Firmenportal zu tun) — ihre Zugaenge sind Konfiguration und bleiben
 * deshalb hier, nicht bei Locations/Lieferanten.
 *
 * Tagesarbeit und Technik sind umgezogen (Struktur-Umbau 2026-10):
 *   Team                → HR › Mitarbeiter               (/mitarbeiter)
 *   Aktivität (alle 3)  → Sicherheit › Anmeldungen       (/sicherheit?tab=anmeldungen&bereich=…)
 *   Vertraute Geräte    → Sicherheit › Geräte            (/sicherheit?tab=geraete)
 *   Developer-Modus     → Sicherheit › Entwickler        (/sicherheit?tab=entwickler)
 * Alte Tab-Schlüssel leiten beim Mount dorthin weiter (VERSCHOBEN), damit
 * Lesezeichen und interne Links weiter funktionieren.
 *
 * Non-Admin sieht nur „Integrationen" (dort haengt sein persoenliches
 * Bexio-/Kalender-Setup) — kein Portal-Switcher, damit er nicht in leere
 * Sub-Tabs klickt.
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
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { usePermissions } from "@/lib/use-permissions";
import { Plug, Shield, Building2, Handshake, FileText, Truck, KeyRound } from "lucide-react";
import { TabsNav } from "@/components/ui/tabs-nav";
import { Skeleton } from "@/components/ui/skeleton";

// Tab-Inhalte via next/dynamic (Bundle-Split): jeder Tab laedt seinen Code
// erst beim Aktivieren (u.a. die VisualBuilder-Kette des Partner-Formulars);
// das Skeleton als loading-Fallback gibt sofortiges Feedback beim ersten
// Tab-Wechsel (CLAUDE.md §7).
// ssr:false ist ok — die Page ist eine reine Client-Component.
const tabLoading = () => (
  <div className="space-y-4">
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-64" />
  </div>
);
// WICHTIG: Die Options MUESSEN als Objekt-Literal direkt im dynamic()-Aufruf
// stehen (Next-Compiler liest sie statisch) — eine geteilte dynOpts-Konstante
// bricht den Production-Build ("options must be an object literal").
const FirmaTab = dynamic(() => import("@/components/einstellungen/firma-tab").then((m) => m.FirmaTab), { ssr: false, loading: tabLoading });
const RollenTab = dynamic(() => import("@/components/einstellungen/rollen-tab").then((m) => m.RollenTab), { ssr: false, loading: tabLoading });
const PermissionAuditLogCard = dynamic(
  () => import("@/components/einstellungen/permission-audit-log").then((m) => m.PermissionAuditLogCard),
  { ssr: false, loading: tabLoading },
);
const IntegrationenTab = dynamic(
  () => import("@/components/einstellungen/integrationen-tab").then((m) => m.IntegrationenTab),
  { ssr: false, loading: tabLoading },
);
const PartnerFormTab = dynamic(() => import("@/components/einstellungen/partner-form-tab").then((m) => m.PartnerFormTab), { ssr: false, loading: tabLoading });
const PartnerTab = dynamic(() => import("@/components/einstellungen/partner-tab").then((m) => m.PartnerTab), { ssr: false, loading: tabLoading });
const LieferantenPortalTab = dynamic(() => import("@/components/einstellungen/lieferanten-portal-tab").then((m) => m.LieferantenPortalTab), { ssr: false, loading: tabLoading });

type Tab =
  | "firma"
  | "rollen"
  | "integrationen"
  | "partner"
  | "partner-rollen"
  | "partner-form"
  | "lieferant"
  | "lieferant-rollen";
type Portal = "firma" | "partner" | "lieferant";

const ALL_TABS: Tab[] = [
  "firma",
  "rollen",
  "integrationen",
  "partner",
  "partner-rollen",
  "partner-form",
  "lieferant",
  "lieferant-rollen",
];

// Welcher Sub-Tab gehoert welcher Portal-Gruppe. Beim Top-Tab-Wechsel
// springen wir auf den ersten Sub-Tab dieser Gruppe (siehe selectPortal).
const PORTAL_OF: Record<Tab, Portal> = {
  firma: "firma",
  rollen: "firma",
  integrationen: "firma",
  partner: "partner",
  "partner-rollen": "partner",
  "partner-form": "partner",
  lieferant: "lieferant",
  "lieferant-rollen": "lieferant",
};

// Legacy-Mapping: alte flache Tabkeys → Portal-Sub-Tabkeys.
const LEGACY_TAB_MAP: Record<string, Tab> = {
  "firma-stammdaten": "firma",
  "anfrage-form": "partner-form",
};

// Umgezogene Bereiche: alter Tab-Schluessel → neuer Ort. Wird beim Mount
// per router.replace angesprungen (Lesezeichen, Hinweise
// „Einstellungen › Team" in anderen Seiten).
const VERSCHOBEN: Record<string, string> = {
  team: "/mitarbeiter",
  "team-rollen": "/mitarbeiter",
  aktivitaet: "/sicherheit?tab=anmeldungen&bereich=firma",
  "partner-aktivitaet": "/sicherheit?tab=anmeldungen&bereich=partner",
  "lieferant-aktivitaet": "/sicherheit?tab=anmeldungen&bereich=lieferant",
};

function resolveTab(raw: string | null): Tab | null {
  if (!raw) return null;
  if ((ALL_TABS as string[]).includes(raw)) return raw as Tab;
  return LEGACY_TAB_MAP[raw] ?? null;
}

export default function EinstellungenPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get("tab");
  const verschobenNach = rawTab ? VERSCHOBEN[rawTab] : undefined;
  const urlTab = resolveTab(rawTab);
  // Default = "firma" (erster Admin-Sub-Tab im Firmenportal). Non-Admin
  // sieht unten abgeleitet immer „integrationen".
  const [tab, setTab] = useState<Tab>(urlTab ?? "firma");
  // Tab-Wechsel von aussen (Befehlspalette, Link auf dieselbe Seite) in den
  // State uebernehmen — Anpassung waehrend des Renders statt per Effect.
  const [letzterUrlTab, setLetzterUrlTab] = useState<Tab | null>(urlTab);
  if (urlTab !== letzterUrlTab) {
    setLetzterUrlTab(urlTab);
    setTab(urlTab ?? "firma");
  }
  // Role via zentralem Permissions-Provider — vermeidet den doppelten
  // profiles-Roundtrip beim Seitenwechsel und teilt die 'admin'-Definition
  // mit dem Rest der (app)/-Baume (hasPermission gated Admin ohnehin
  // durch, siehe permissions.ts).
  const { role, ready } = usePermissions();
  const isAdmin: boolean | null = ready ? role === "admin" : null;

  // Alter Tab-Schluessel eines umgezogenen Bereichs → an den neuen Ort.
  useEffect(() => {
    if (verschobenNach) router.replace(verschobenNach);
  }, [verschobenNach, router]);

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

  // Non-Admin sieht nur Integrationen — abgeleitet statt per Effect
  // umgeleitet, damit nie ein Admin-Tab aufblitzt.
  const activeTab: Tab = isAdmin ? tab : "integrationen";
  const activePortal: Portal = PORTAL_OF[activeTab];

  // Top-Tab-Wechsel → ersten Sub-Tab dieser Portal-Gruppe oeffnen.
  function selectPortal(p: Portal) {
    if (activePortal === p) return;
    selectTab(p === "firma" ? "firma" : p === "partner" ? "partner" : "lieferant");
  }

  // Firmenportal-Sub-Tabs (admin sieht alles, Non-Admin nur Integrationen).
  const firmaTabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    ...(isAdmin
      ? [
          { key: "firma" as Tab, label: "Firma", icon: <Building2 className="h-4 w-4" /> },
          { key: "rollen" as Tab, label: "Rollen", icon: <Shield className="h-4 w-4" /> },
        ]
      : []),
    { key: "integrationen", label: "Integrationen", icon: <Plug className="h-4 w-4" /> },
  ];

  // Partnerportal-Sub-Tabs — Zugaenge (Partner-Logins), Rollen und
  // Anfrage-Formular. Nur fuer Admin.
  const partnerTabs: { key: Tab; label: string; icon: React.ReactNode }[] = isAdmin
    ? [
        { key: "partner" as Tab, label: "Zugänge", icon: <KeyRound className="h-4 w-4" /> },
        { key: "partner-rollen" as Tab, label: "Rollen", icon: <Shield className="h-4 w-4" /> },
        { key: "partner-form" as Tab, label: "Anfrage-Formular", icon: <FileText className="h-4 w-4" /> },
      ]
    : [];

  // Lieferantenportal-Sub-Tabs — Zugaenge (Lieferanten-Logins inkl.
  // Kataloge) und Rollen-Matrix. Nur fuer Admin.
  const lieferantTabs: { key: Tab; label: string; icon: React.ReactNode }[] = isAdmin
    ? [
        { key: "lieferant" as Tab, label: "Zugänge", icon: <KeyRound className="h-4 w-4" /> },
        { key: "lieferant-rollen" as Tab, label: "Rollen", icon: <Shield className="h-4 w-4" /> },
      ]
    : [];

  const subTabs = activePortal === "firma" ? firmaTabs : activePortal === "partner" ? partnerTabs : lieferantTabs;

  const portalTabs = [
    { key: "firma", label: "Firmenportal", icon: <Building2 className="h-4 w-4" /> },
    { key: "partner", label: "Partnerportal", icon: <Handshake className="h-4 w-4" /> },
    { key: "lieferant", label: "Lieferantenportal", icon: <Truck className="h-4 w-4" /> },
  ];

  // Solange Rolle nicht ready ist (oder ein alter Tab-Schluessel gerade
  // weiterleitet) rendern wir NICHTS — sonst blitzt kurz ein falscher
  // Tab-Inhalt auf.
  if (!ready || verschobenNach) return null;

  return (
    <div className="space-y-8">
      {/* Header — konsistent mit /mein-konto (h1 + Untertitel). */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isAdmin
            ? "Firmendaten, Integrationen, Rollen und Rechte der drei Portale, Zugänge für Partner und Lieferanten sowie das Anfrage-Formular für Partner."
            : "Verknüpfungen mit externen Tools wie Bexio und Kalender."}
        </p>
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
              className={activeTab === t.key ? "kasten-active" : "kasten-toggle-off"}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "firma" && isAdmin && <FirmaTab isAdmin={isAdmin} />}

      {activeTab === "rollen" && isAdmin && (
        <div className="space-y-6">
          <RollenTab scope="firma" />
          <PermissionAuditLogCard />
        </div>
      )}

      {activeTab === "integrationen" && (
        <div className="space-y-6">
          <IntegrationenTab />
        </div>
      )}

      {activeTab === "partner" && isAdmin && <PartnerTab />}

      {activeTab === "partner-rollen" && isAdmin && <RollenTab scope="partner" />}

      {activeTab === "partner-form" && isAdmin && <PartnerFormTab />}

      {activeTab === "lieferant" && isAdmin && <LieferantenPortalTab />}

      {activeTab === "lieferant-rollen" && isAdmin && <RollenTab scope="lieferant" />}
    </div>
  );
}
