"use client";

/**
 * Einstellungen-Page — ALLE Admin-Einstellungen an einem Ort. 3 Top-Tabs
 * (Firmenportal / Partnerportal / Lieferantenportal) mit jeweils eigenen
 * Sub-Sektionen. Die zwei-Ebenen-Struktur bleibt, weil sich hinter den
 * Portalen fachlich getrennte Welten verbergen (Firma-Mitarbeiter vs
 * Location-Partner vs Lieferanten).
 *
 * Struktur:
 *   Firmenportal      → Firma / Mitarbeiter / Rollen / Integrationen / Sicherheit
 *   Partnerportal     → Zugänge / Rollen / Anfrage-Formular / Anmeldungen
 *   Lieferantenportal → Zugänge / Anmeldungen
 * Das Lieferantenportal hat einen festen Funktionsumfang (Anfragen, Katalog,
 * Mein Wissen, Mein Konto) und darum keine Rollen-Matrix. Die Kataloge
 * werden auf /lieferanten gepflegt (Katalog-Fenster je Lieferant), nicht hier.
 * Sicherheit = drei Abschnitte untereinander (Anmeldungen des Teams,
 * vertraute Geraete, Entwickler-Modus) — keine dritte Navigationsebene.
 * Partner- und Lieferantenportal sind eigenstaendig (nichts mit dem
 * Firmenportal zu tun) — ihre Zugaenge sind Konfiguration und bleiben
 * deshalb hier, nicht bei Locations/Lieferanten.
 *
 * Regel fuer Neues: eine neue Einstellung wird ein Sub-Tab im passenden
 * Portal (keine eigene Seite in der Sidebar). Werden es in einem Portal zu
 * viele Sub-Tabs, Verwandtes zu EINEM Sub-Tab mit Abschnitten gruppieren
 * (Muster: Sicherheit).
 *
 * Non-Admin sieht nur „Integrationen" (dort haengt sein persoenliches
 * Bexio-/Kalender-Setup) — kein Portal-Switcher, damit er nicht in leere
 * Sub-Tabs klickt.
 *
 * URL-Persistenz via ?tab=... (history.replaceState). Alte Tab-Schluessel
 * (kurze Flach-Aera, Team/Aktivitaet, die Zwischenseiten /mitarbeiter und
 * /sicherheit) werden auf die passenden Sub-Tabs gemappt, damit Deep-Links
 * (Bexio-Callback, /partner-Redirect, Lesezeichen) weiter funktionieren.
 *
 * Nav-Muster: beide Ebenen = TabsNav (Underline, roter Strich, Icon h-4) —
 * kanonisches Tab-Muster app-weit (CLAUDE.md B4; Kasten-Knoepfe als Tabs
 * sind seit 2026-10-15 veraltet). Oben der Portal-Umschalter, darunter die
 * Bereiche des gewaehlten Portals; der aktive Bereich steht in ?tab=… .
 */

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { usePermissions } from "@/lib/use-permissions";
import { Plug, Shield, ShieldCheck, Building2, Handshake, FileText, Truck, KeyRound, Users, LogIn } from "lucide-react";
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
const TeamTab = dynamic(() => import("@/components/einstellungen/team-tab").then((m) => m.TeamTab), { ssr: false, loading: tabLoading });
const RollenTab = dynamic(() => import("@/components/einstellungen/rollen-tab").then((m) => m.RollenTab), { ssr: false, loading: tabLoading });
const PermissionAuditLogCard = dynamic(
  () => import("@/components/einstellungen/permission-audit-log").then((m) => m.PermissionAuditLogCard),
  { ssr: false, loading: tabLoading },
);
const IntegrationenTab = dynamic(
  () => import("@/components/einstellungen/integrationen-tab").then((m) => m.IntegrationenTab),
  { ssr: false, loading: tabLoading },
);
const SicherheitTab = dynamic(() => import("@/components/einstellungen/sicherheit-tab").then((m) => m.SicherheitTab), { ssr: false, loading: tabLoading });
const AktivitaetTab = dynamic(() => import("@/components/einstellungen/aktivitaet-tab").then((m) => m.AktivitaetTab), { ssr: false, loading: tabLoading });
const PartnerFormTab = dynamic(() => import("@/components/einstellungen/partner-form-tab").then((m) => m.PartnerFormTab), { ssr: false, loading: tabLoading });
const PartnerTab = dynamic(() => import("@/components/einstellungen/partner-tab").then((m) => m.PartnerTab), { ssr: false, loading: tabLoading });
const LieferantenPortalTab = dynamic(() => import("@/components/einstellungen/lieferanten-portal-tab").then((m) => m.LieferantenPortalTab), { ssr: false, loading: tabLoading });

type Tab =
  | "firma"
  | "mitarbeiter"
  | "rollen"
  | "integrationen"
  | "sicherheit"
  | "partner"
  | "partner-rollen"
  | "partner-form"
  | "partner-aktivitaet"
  | "lieferant"
  | "lieferant-aktivitaet";
type Portal = "firma" | "partner" | "lieferant";

const ALL_TABS: Tab[] = [
  "firma",
  "mitarbeiter",
  "rollen",
  "integrationen",
  "sicherheit",
  "partner",
  "partner-rollen",
  "partner-form",
  "partner-aktivitaet",
  "lieferant",
  "lieferant-aktivitaet",
];

// Welcher Sub-Tab gehoert welcher Portal-Gruppe. Beim Top-Tab-Wechsel
// springen wir auf den ersten Sub-Tab dieser Gruppe (siehe selectPortal).
const PORTAL_OF: Record<Tab, Portal> = {
  firma: "firma",
  mitarbeiter: "firma",
  rollen: "firma",
  integrationen: "firma",
  sicherheit: "firma",
  partner: "partner",
  "partner-rollen": "partner",
  "partner-form": "partner",
  "partner-aktivitaet": "partner",
  lieferant: "lieferant",
  "lieferant-aktivitaet": "lieferant",
};

// Alte Tab-Schluessel → heutiger Sub-Tab. Deckt Lesezeichen und Links ab:
// flache Tabs von frueher, Team/Aktivitaet, die Tabs der kurzlebigen
// Seite /sicherheit (die selbst hierher weiterleitet) und die entfernte
// Lieferanten-Rollen-Matrix (landet auf den Zugaengen).
const LEGACY_TAB_MAP: Record<string, Tab> = {
  "firma-stammdaten": "firma",
  "anfrage-form": "partner-form",
  team: "mitarbeiter",
  "team-rollen": "mitarbeiter",
  aktivitaet: "sicherheit",
  geraete: "sicherheit",
  entwickler: "sicherheit",
  "lieferant-rollen": "lieferant",
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
  const firmaTabs: { key: Tab; label: string; icon: React.ReactNode }[] = isAdmin
    ? [
        { key: "firma", label: "Firma", icon: <Building2 className="h-4 w-4" /> },
        { key: "mitarbeiter", label: "Mitarbeiter", icon: <Users className="h-4 w-4" /> },
        { key: "rollen", label: "Rollen", icon: <Shield className="h-4 w-4" /> },
        { key: "integrationen", label: "Integrationen", icon: <Plug className="h-4 w-4" /> },
        { key: "sicherheit", label: "Sicherheit", icon: <ShieldCheck className="h-4 w-4" /> },
      ]
    : [{ key: "integrationen", label: "Integrationen", icon: <Plug className="h-4 w-4" /> }];

  // Partnerportal-Sub-Tabs — Zugaenge (Partner-Logins), Rollen,
  // Anfrage-Formular und Anmeldungen der Partner. Nur fuer Admin.
  const partnerTabs: { key: Tab; label: string; icon: React.ReactNode }[] = isAdmin
    ? [
        { key: "partner", label: "Zugänge", icon: <KeyRound className="h-4 w-4" /> },
        { key: "partner-rollen", label: "Rollen", icon: <Shield className="h-4 w-4" /> },
        { key: "partner-form", label: "Anfrage-Formular", icon: <FileText className="h-4 w-4" /> },
        { key: "partner-aktivitaet", label: "Anmeldungen", icon: <LogIn className="h-4 w-4" /> },
      ]
    : [];

  // Lieferantenportal-Sub-Tabs — Zugaenge (Lieferanten-Logins) und
  // Anmeldungen der Lieferanten. Keine Rollen: fester Funktionsumfang.
  // Nur fuer Admin.
  const lieferantTabs: { key: Tab; label: string; icon: React.ReactNode }[] = isAdmin
    ? [
        { key: "lieferant", label: "Zugänge", icon: <KeyRound className="h-4 w-4" /> },
        { key: "lieferant-aktivitaet", label: "Anmeldungen", icon: <LogIn className="h-4 w-4" /> },
      ]
    : [];

  const subTabs = activePortal === "firma" ? firmaTabs : activePortal === "partner" ? partnerTabs : lieferantTabs;

  const portalTabs = [
    { key: "firma", label: "Firmenportal", icon: <Building2 className="h-4 w-4" /> },
    { key: "partner", label: "Partnerportal", icon: <Handshake className="h-4 w-4" /> },
    { key: "lieferant", label: "Lieferantenportal", icon: <Truck className="h-4 w-4" /> },
  ];

  // Solange Rolle nicht ready ist rendern wir NICHTS — sonst blitzt kurz
  // ein falscher Tab-Inhalt auf.
  if (!ready) return null;

  return (
    <div className="space-y-8">
      {/* Header — konsistent mit /mein-konto (h1 + Untertitel). */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isAdmin
            ? "Firma, Mitarbeiter, Rollen, Integrationen und Sicherheit — dazu Zugänge und Anmeldungen der Partner und Lieferanten sowie Rollen und Anfrage-Formular für Partner."
            : "Verknüpfungen mit externen Tools wie Bexio und Kalender."}
        </p>
      </div>

      {/* Zwei-Ebenen-Navigation, beide als TabsNav: oben der Portal-
          Umschalter, darunter die Bereiche des Portals. Non-Admin sieht
          keine Portal-Umschalter (nur Integrationen im Firmenportal). */}
      <div>
        {isAdmin && (
          <TabsNav
            tabs={portalTabs}
            active={activePortal}
            onChange={(k) => selectPortal(k as Portal)}
            ariaLabel="Portal-Umschalter"
          />
        )}

        <TabsNav
          tabs={subTabs}
          active={activeTab}
          onChange={(k) => selectTab(k as Tab)}
          ariaLabel="Bereiche"
          className={isAdmin ? "mt-8" : undefined}
        />
      </div>

      {activeTab === "firma" && isAdmin && <FirmaTab isAdmin={isAdmin} />}

      {activeTab === "mitarbeiter" && isAdmin && <TeamTab />}

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

      {activeTab === "sicherheit" && isAdmin && <SicherheitTab />}

      {activeTab === "partner" && isAdmin && <PartnerTab />}

      {activeTab === "partner-rollen" && isAdmin && <RollenTab scope="partner" />}

      {activeTab === "partner-form" && isAdmin && <PartnerFormTab />}

      {activeTab === "partner-aktivitaet" && isAdmin && <AktivitaetTab scope="partner" />}

      {activeTab === "lieferant" && isAdmin && <LieferantenPortalTab />}

      {activeTab === "lieferant-aktivitaet" && isAdmin && <AktivitaetTab scope="lieferant" />}
    </div>
  );
}
