"use client";

/**
 * HR-Hub — EIN Sidebar-Eintrag, mehrere Tabs.
 *
 * Rolle-Trennung (2026-09):
 *   Admin sieht: Anfragen · Stempelzeiten · Tickets · Ferien · Lohn
 *   MA  sieht:            Stempelzeiten · Tickets · Ferien · Lohn
 *
 *   „Anfragen" ersetzt den frueheren „Uebersicht"-Tab und ist Admin-only.
 *   MA landen bei Deep-Link ohne Tab (oder auf einem nicht-sichtbaren Tab)
 *   auf „stempelzeiten".
 *
 * Toggle „Meine | Team" pro personen-basiertem Tab:
 *     - Stempelzeiten: Toggle in StempelzeitenView.
 *     - Tickets: Toggle in TicketsView.
 *     - Ferien: Toggle in FerienView.
 *     - Lohn: Toggle auf HR-Ebene (Team-Sicht komplett anders).
 *
 * Lohn-Tab:
 *   - MA-Sicht (default): eigene PDFs + Lohnausweise + Digital-Consent.
 *   - Admin-Sicht (Toggle „Team"): Sub-Tabs Monatsstunden/PDFs/
 *     Mitarbeiter/Standardwerte. TrustedDeviceGate wrapt nur die
 *     Team-Sicht.
 *
 * Sub-Tab-Rename Legacy-Mapping bleibt fuer alte Deep-Links.
 *
 * Tab-Zustand ueberlebt Reload via URL-Query (?tab=…&subtab=…&lohn=…).
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Briefcase, Clock, TicketCheck, Palmtree, Wallet,
  Table, FileText, Users, Settings as SettingsIcon, Inbox,
} from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { TabsNav } from "@/components/ui/tabs-nav";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";
import { StempelzeitenView } from "@/components/stempelzeiten/stempelzeiten-view";
import { TicketsView } from "@/components/tickets/tickets-view";
import { FerienView } from "@/components/ferien/ferien-view";
import { AnfragenTab } from "@/components/hr/anfragen-tab";
import { LohndokumenteAdmin } from "@/components/hr/lohndokumente-admin";
import { MonatsstundenTable } from "@/components/hr/monatsstunden-table";
import { LohnStandardwerteCard } from "@/components/hr/loehne/lohn-standardwerte-card";
import { MitarbeiterLohnTab } from "@/components/hr/loehne/mitarbeiter-lohn-tab";
import { LohnausweiseList } from "@/components/hr/lohnausweise-list";
import { BackButton } from "@/components/ui/back-button";

type Tab = "anfragen" | "stempelzeiten" | "tickets" | "ferien" | "loehne";
type LoehneSubTab = "monatsstunden" | "pdfs" | "mitarbeiter" | "standardwerte";
type LohnMode = "meine" | "team";

const ALL_TABS: Tab[] = ["anfragen", "stempelzeiten", "tickets", "ferien", "loehne"];
const ALL_SUBTABS: LoehneSubTab[] = ["monatsstunden", "pdfs", "mitarbeiter", "standardwerte"];

/**
 * Legacy-Mapping fuer die alten Sub-Tab-Keys — alte Deep-Links
 * (?subtab=abrechnung etc.) werden transparent auf die neuen Keys
 * umgeschrieben. Zurueckgeben: mapped key ODER unveraenderten Wert.
 */
function mapLegacySubtab(raw: string | null): LoehneSubTab | null {
  if (!raw) return null;
  const legacy: Record<string, LoehneSubTab> = {
    abrechnung: "monatsstunden",
    lohnabrechnungen: "pdfs",
    "mitarbeiter-lohn": "mitarbeiter",
  };
  const mapped = legacy[raw];
  if (mapped) return mapped;
  return ALL_SUBTABS.includes(raw as LoehneSubTab) ? (raw as LoehneSubTab) : null;
}

/**
 * Alter Tab-Key „uebersicht" (der jetzt geloescht ist) auf den neuen
 * Landing-Tab pro Rolle umschreiben — damit alte Bookmarks/Deep-Links
 * nicht ins Leere zeigen.
 */
function mapLegacyTab(raw: string | null, canManageHR: boolean): Tab | null {
  if (!raw) return null;
  if (raw === "uebersicht") return canManageHR ? "anfragen" : "stempelzeiten";
  return ALL_TABS.includes(raw as Tab) ? (raw as Tab) : null;
}

export default function HRPage() {
  const searchParams = useSearchParams();
  const urlTabRaw = searchParams.get("tab");
  const urlSub = searchParams.get("subtab");
  const urlLohnMode = searchParams.get("lohn") as LohnMode | null;

  const { can, ready } = usePermissions();
  // "Anfragen"-Tab + Team-Uebersicht: Permission-gegated statt Rolle. Admins
  // bekommen `hr:manage`/`lohn:manage` automatisch via hasPermission-Bypass;
  // andere Rollen koennen es via Rollen-Matrix (lohn:manage) bekommen.
  const canManageHR = can("hr:manage");
  const canManageLohn = can("lohn:manage");

  // Default-Landing: HR-Manager → Anfragen, MA → Stempelzeiten.
  const defaultTab: Tab = canManageHR ? "anfragen" : "stempelzeiten";
  const initialTab = mapLegacyTab(urlTabRaw, canManageHR) ?? defaultTab;

  const [tab, setTab] = useState<Tab>(initialTab);
  const [subTab, setSubTab] = useState<LoehneSubTab>(mapLegacySubtab(urlSub) ?? "monatsstunden");
  // Lohn-Modus: Manager default „team", MA immer „meine" (kein Umschalter).
  const [lohnMode, setLohnMode] = useState<LohnMode>(urlLohnMode ?? "team");

  // URL → Local-State-Sync (Back/Forward-Navigation, Deep-Links).
  useEffect(() => {
    const mapped = mapLegacyTab(urlTabRaw, canManageHR);
    if (mapped) setTab(mapped);
  }, [urlTabRaw, canManageHR]);
  useEffect(() => {
    const mapped = mapLegacySubtab(urlSub);
    if (mapped) setSubTab(mapped);
  }, [urlSub]);
  useEffect(() => {
    if (urlLohnMode === "meine" || urlLohnMode === "team") setLohnMode(urlLohnMode);
  }, [urlLohnMode]);

  function selectTab(t: Tab) {
    setTab(t);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", t);
      if (t !== "loehne") {
        url.searchParams.delete("subtab");
        url.searchParams.delete("lohn");
      }
      window.history.replaceState({}, "", url.toString());
    }
  }

  function selectSubTab(s: LoehneSubTab) {
    setSubTab(s);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "loehne");
      url.searchParams.set("subtab", s);
      window.history.replaceState({}, "", url.toString());
    }
  }

  function selectLohnMode(m: LohnMode) {
    setLohnMode(m);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "loehne");
      url.searchParams.set("lohn", m);
      if (m === "meine") url.searchParams.delete("subtab");
      window.history.replaceState({}, "", url.toString());
    }
  }

  if (!ready) return null;

  const effectiveLohnMode: LohnMode = canManageLohn ? lohnMode : "meine";

  // Tab-Sichtbarkeit — „Anfragen" nur fuer HR-Manager (hr:manage). Reihenfolge:
  // Anfragen zuerst (dort landet der Manager), danach die operativen Tabs.
  const tabs: { key: Tab; label: string; icon: React.ReactNode; visible: boolean }[] = [
    { key: "anfragen",      label: "Anfragen",     icon: <Inbox className="h-4 w-4" />,          visible: canManageHR },
    { key: "stempelzeiten", label: "Stempelzeiten", icon: <Clock className="h-4 w-4" />,          visible: can("stempelzeiten:view") },
    { key: "tickets",       label: "Tickets",       icon: <TicketCheck className="h-4 w-4" />,    visible: can("tickets:view") },
    { key: "ferien",        label: "Abwesenheit",   icon: <Palmtree className="h-4 w-4" />,       visible: true },
    { key: "loehne",        label: "Lohn",          icon: <Wallet className="h-4 w-4" />,         visible: true },
  ];

  const visibleTabs = tabs.filter((t) => t.visible);
  // Fallback wenn der aktuelle Tab fuer die Rolle unsichtbar ist.
  const activeTab: Tab = visibleTabs.some((t) => t.key === tab)
    ? tab
    : (visibleTabs[0]?.key ?? "stempelzeiten");

  const loehneSubTabs: { key: LoehneSubTab; label: string; icon: React.ReactNode }[] = [
    { key: "monatsstunden", label: "Monatsstunden", icon: <Table className="h-4 w-4" /> },
    { key: "pdfs",          label: "PDFs",          icon: <FileText className="h-4 w-4" /> },
    { key: "mitarbeiter",   label: "Mitarbeiter",   icon: <Users className="h-4 w-4" /> },
    { key: "standardwerte", label: "Standardwerte", icon: <SettingsIcon className="h-4 w-4" /> },
  ];

  // Zurueck-Pfeil zeigen, wenn User via Dashboard-Link (?from=dashboard)
  // hierhergekommen ist — z.B. via "Ferien-Antraege pending"-Kachel.
  // Bei normaler Sidebar-Navigation kein Pfeil (unnoetige Kluft).
  const fromDashboard = searchParams.get("from") === "dashboard";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 min-w-0">
        {fromDashboard && <BackButton fallbackHref="/dashboard" />}
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Briefcase className="h-5 w-5" />
          HR
        </h1>
      </div>

      <TabsNav
        tabs={visibleTabs.map((t) => ({ key: t.key, label: t.label, icon: t.icon }))}
        active={activeTab}
        onChange={(k) => selectTab(k as Tab)}
        ariaLabel="HR-Bereiche"
        className="mb-4"
      />

      {activeTab === "anfragen" && canManageHR && (
        <AnfragenTab onGoto={(t) => selectTab(t)} />
      )}

      {activeTab === "stempelzeiten" && can("stempelzeiten:view") && (
        <StempelzeitenView />
      )}

      {activeTab === "tickets" && can("tickets:view") && (
        <TicketsView />
      )}

      {activeTab === "ferien" && (
        <FerienView />
      )}

      {activeTab === "loehne" && (
        <div className="space-y-4">
          {canManageLohn && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Lohn</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {effectiveLohnMode === "meine"
                    ? "Deine Lohnabrechnungen & Lohnausweise."
                    : "Team-Verwaltung: Monatsstunden, PDFs, Mitarbeiter-Loehne."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => selectLohnMode("meine")}
                  className={effectiveLohnMode === "meine" ? "kasten-active" : "kasten-toggle-off"}
                >
                  Meine
                </button>
                <button
                  type="button"
                  onClick={() => selectLohnMode("team")}
                  className={effectiveLohnMode === "team" ? "kasten-active" : "kasten-toggle-off"}
                >
                  Team
                </button>
              </div>
            </div>
          )}

          {effectiveLohnMode === "meine" && (
            <div className="max-w-5xl">
              <LohnausweiseList />
            </div>
          )}

          {effectiveLohnMode === "team" && canManageLohn && (
            <TrustedDeviceGate>
              <div className="flex flex-wrap gap-2">
                {loehneSubTabs.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => selectSubTab(t.key)}
                    className={subTab === t.key ? "kasten-active" : "kasten-toggle-off"}
                  >
                    {t.icon}
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="pt-2">
                {subTab === "monatsstunden" && <MonatsstundenTable />}
                {subTab === "pdfs" && <LohndokumenteAdmin />}
                {subTab === "mitarbeiter" && <MitarbeiterLohnTab />}
                {subTab === "standardwerte" && <LohnStandardwerteCard />}
              </div>
            </TrustedDeviceGate>
          )}
        </div>
      )}
    </div>
  );
}
