"use client";

/**
 * Einstellungen-Page — Tabs: Team, Rollen, Aktivitaet (admin-only),
 * Integrationen. Backup-Tab raus: nightly Backup laeuft vom Ugreen-NAS
 * gepullt.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Plug, Users, Shield, Activity, Building2, Handshake, FileText, Megaphone } from "lucide-react";
import { cn } from "@/lib/utils";
import { IntegrationenTab } from "@/components/einstellungen/integrationen-tab";
import { TeamTab } from "@/components/einstellungen/team-tab";
import { RollenTab } from "@/components/einstellungen/rollen-tab";
import { AktivitaetTab } from "@/components/einstellungen/aktivitaet-tab";
import { PartnerTab } from "@/components/einstellungen/partner-tab";
import { PartnerFormTab } from "@/components/einstellungen/partner-form-tab";
import { MitteilungTab } from "@/components/einstellungen/mitteilung-tab";
import { BuildInfoBadge } from "@/components/einstellungen/build-info-badge";

type Tab = "integrationen" | "team" | "rollen" | "aktivitaet" | "mitteilung" | "partner" | "partner-rollen" | "partner-aktivitaet" | "partner-form";
type Portal = "firma" | "partner";

const ALL_TABS: Tab[] = ["integrationen", "team", "rollen", "aktivitaet", "mitteilung", "partner", "partner-rollen", "partner-aktivitaet", "partner-form"];

// Welcher Haupt-Tab gehoert welcher Portal-Gruppe. Beim Wechsel des
// Haupt-Tabs springen wir automatisch auf den ersten Sub-Tab dieser
// Gruppe (siehe selectPortal).
const PORTAL_OF: Record<Tab, Portal> = {
  team: "firma",
  rollen: "firma",
  aktivitaet: "firma",
  integrationen: "firma",
  mitteilung: "firma",
  partner: "partner",
  "partner-rollen": "partner",
  "partner-aktivitaet": "partner",
  "partner-form": "partner",
};

export default function EinstellungenPage() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab") as Tab | null;
  // Default = "team" weil das der erste sichtbare Tab fuer Admin ist
  // (Reihenfolge: Team → Rollen → Integrationen). Fuer Non-Admin wird
  // unten via useEffect auf "integrationen" umgeleitet sobald der
  // Admin-Status geladen ist.
  const [tab, setTab] = useState<Tab>(urlTab && ALL_TABS.includes(urlTab) ? urlTab : "team");
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  // Tab-Wechsel: state = sofortige UI-Quelle, URL parallel updaten via
  // History-API damit Hard-Reload den gleichen Tab zeigt. Wir umgehen
  // den Next-Router (router.replace mit Query-Only-Update triggerte in
  // Next 16 weder re-render noch URL-Update zuverlaessig). History.API
  // ist garantiert synchron + ohne Navigation.
  function selectTab(t: Tab) {
    setTab(t);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", t);
      window.history.replaceState({}, "", url.toString());
    }
  }

  // Haupt-Tab-Wechsel → ersten Sub-Tab dieser Portal-Gruppe oeffnen.
  function selectPortal(p: Portal) {
    if (PORTAL_OF[tab] === p) return;
    selectTab(p === "firma" ? "team" : "partner");
  }

  const activePortal: Portal = PORTAL_OF[tab];

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setIsAdmin(false);
        return;
      }
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
      const admin = profile?.role === "admin";
      setIsAdmin(admin);
      // Non-Admin auf einem Admin-only-Tab -> Integrationen.
      // Benachrichtigungen + Mein-Konto wanderten in /mein-konto.
      if (!admin && tab !== "integrationen") {
        selectTab("integrationen");
      }
    })();
  }, [supabase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Firmenportal-Sub-Tabs (admin sieht Team/Rollen/Aktivitaet/Integrationen,
  // Non-Admin nur Integrationen — siehe useEffect-Redirect oben).
  const firmaTabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    ...(isAdmin ? [
      { key: "team" as Tab, label: "Team", icon: <Users className="h-4 w-4" /> },
      { key: "rollen" as Tab, label: "Rollen", icon: <Shield className="h-4 w-4" /> },
      { key: "aktivitaet" as Tab, label: "Aktivität", icon: <Activity className="h-4 w-4" /> },
      { key: "mitteilung" as Tab, label: "Mitteilung", icon: <Megaphone className="h-4 w-4" /> },
    ] : []),
    { key: "integrationen", label: "Integrationen", icon: <Plug className="h-4 w-4" /> },
  ];

  // Partnerportal-Sub-Tabs — Partner-Benutzerliste, Rollen, Aktivitaet.
  const partnerTabs: { key: Tab; label: string; icon: React.ReactNode }[] = isAdmin ? [
    { key: "partner" as Tab, label: "Partner", icon: <Building2 className="h-4 w-4" /> },
    { key: "partner-rollen" as Tab, label: "Rollen", icon: <Shield className="h-4 w-4" /> },
    { key: "partner-form" as Tab, label: "Anfrage-Form", icon: <FileText className="h-4 w-4" /> },
    { key: "partner-aktivitaet" as Tab, label: "Aktivität", icon: <Activity className="h-4 w-4" /> },
  ] : [];

  const subTabs = activePortal === "firma" ? firmaTabs : partnerTabs;

  return (
    <div className="space-y-6">
      {/* Header — gleiche Struktur wie /auftraege etc. (h1 + Subtitle-Spacer
          fuer konsistente Hoehe app-weit). Rechts oben das Build-Info-
          Fun-Fact-Widget (Version, LOC, Wort-Count). */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Einstellungen</h1>
          <p className="text-sm text-muted-foreground mt-1" aria-hidden="true">&nbsp;</p>
        </div>
        <BuildInfoBadge />
      </div>

      {/* Haupt-Tabs (Underline-Style à la Partner-Portal-Layout) + Sub-Tabs
          (kasten-Toggle-Stil) bilden eine visuelle Einheit — Haupt-Tab trennt
          die beiden Mitarbeiter-Kreise (Eventline-intern vs Locationspartner
          mit eigener Rollen-Hierarchie), Sub-Tab zeigt die jeweilige Section. */}
      <div className="space-y-4">
        {isAdmin && (
          <nav className="border-b flex gap-1">
            {([
              { key: "firma" as Portal, label: "Firmenportal", icon: <Building2 className="h-4 w-4" /> },
              { key: "partner" as Portal, label: "Partnerportal", icon: <Handshake className="h-4 w-4" /> },
            ]).map((p) => {
              const active = activePortal === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => selectPortal(p.key)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2.5 -mb-px text-sm font-medium border-b-2 transition-colors",
                    active
                      ? "border-red-500 text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-foreground/20",
                  )}
                >
                  {p.icon}
                  {p.label}
                </button>
              );
            })}
          </nav>
        )}

        <div className="flex flex-wrap gap-2">
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

      {tab === "integrationen" && (
        <div className="space-y-6">
          <IntegrationenTab />
        </div>
      )}

      {tab === "team" && isAdmin && <TeamTab />}

      {tab === "partner" && isAdmin && <PartnerTab />}

      {tab === "rollen" && isAdmin && <RollenTab scope="firma" />}

      {tab === "partner-rollen" && isAdmin && <RollenTab scope="partner" />}

      {tab === "partner-form" && isAdmin && <PartnerFormTab />}

      {tab === "aktivitaet" && isAdmin && <AktivitaetTab scope="firma" />}

      {tab === "mitteilung" && isAdmin && <MitteilungTab />}

      {tab === "partner-aktivitaet" && isAdmin && <AktivitaetTab scope="partner" />}
    </div>
  );
}
