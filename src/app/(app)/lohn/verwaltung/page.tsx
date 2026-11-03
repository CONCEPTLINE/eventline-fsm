"use client";

/**
 * BEFRISTET — wird in Phase 2 nach dem Lohnlauf November 2026 entfernt
 * (ab Lohnmonat Dezember 2026 rechnet Trust flow/Bexio).
 *
 * Lohnverwaltung (/lohn/verwaltung): die Werkzeuge der früheren Team-Ansicht
 * von /lohn, solange das ERP noch Löhne rechnet (Oktober, Auszahlung bis 6.11.;
 * November, letzter Lauf Anfang Dezember). Reiter Lohndokumente |
 * Mitarbeiter-Lohn | Standardwerte mit den bestehenden Komponenten
 * (unverändert). Die Monatsstunden liegen unter Stempelzeiten › Prüfen.
 *
 * Nur lohn:manage, nur auf einem vertrauten Gerät (TrustedDeviceGate).
 * Reiter in der URL: ?tab=dokumente|mitarbeiter|standardwerte (CLAUDE.md §10;
 * alte Aliase: src/components/hr/lohn-bereiche.ts).
 */

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { FileText, Settings as SettingsIcon, Users, Wallet } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { BackButton } from "@/components/ui/back-button";
import { TabsNav } from "@/components/ui/tabs-nav";
import { EmptyState } from "@/components/ui/empty-state";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";
import { LohndokumenteAdmin } from "@/components/hr/lohndokumente-admin";
import { MitarbeiterLohnTab } from "@/components/hr/loehne/mitarbeiter-lohn-tab";
import { LohnStandardwerteCard } from "@/components/hr/loehne/lohn-standardwerte-card";
import { LOHN_PARAM_BEREICH, resolveVerwaltungBereich, type VerwaltungBereich } from "@/components/hr/lohn-bereiche";
import Loading from "./loading";

const BEREICHE: { key: VerwaltungBereich; label: string; icon: React.ReactNode }[] = [
  { key: "dokumente", label: "Lohndokumente", icon: <FileText className="h-4 w-4" /> },
  { key: "mitarbeiter", label: "Mitarbeiter-Lohn", icon: <Users className="h-4 w-4" /> },
  { key: "standardwerte", label: "Standardwerte", icon: <SettingsIcon className="h-4 w-4" /> },
];

export default function LohnVerwaltungPage() {
  const searchParams = useSearchParams();
  const { can, ready } = usePermissions();
  const urlBereich = resolveVerwaltungBereich(searchParams.get(LOHN_PARAM_BEREICH)) ?? "dokumente";
  // Klick wirkt sofort; eine von aussen geänderte URL gewinnt wieder (Abgleich beim Rendern).
  const [gewaehlt, setGewaehlt] = useState<VerwaltungBereich>(urlBereich);
  const [gesehen, setGesehen] = useState<VerwaltungBereich>(urlBereich);
  if (urlBereich !== gesehen) {
    setGesehen(urlBereich);
    setGewaehlt(urlBereich);
  }

  if (!ready) return <Loading />;

  function waehle(k: string) {
    const b = resolveVerwaltungBereich(k) ?? "dokumente";
    setGewaehlt(b);
    const url = new URL(window.location.href);
    url.searchParams.set(LOHN_PARAM_BEREICH, b);
    window.history.replaceState(window.history.state, "", url.toString());
  }

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-3 min-w-0">
        <BackButton fallbackHref="/lohn" />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Lohnverwaltung</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Lohndokumente, Mitarbeiter-Lohn und Standardwerte — bis zum Lohnlauf November 2026, danach rechnet Trust flow.
          </p>
        </div>
      </div>

      {!can("lohn:manage") ? (
        <div className="rounded-xl border border-dashed border-border bg-card">
          <EmptyState icon={Wallet} title="Kein Zugriff" description="Die Lohnverwaltung ist nur mit dem Lohnrecht sichtbar." />
        </div>
      ) : (
        <TrustedDeviceGate>
          <div className="space-y-4">
            <TabsNav tabs={BEREICHE} active={gewaehlt} onChange={waehle} ariaLabel="Lohnverwaltung" />
            <div className="pt-2">
              {gewaehlt === "dokumente" && <LohndokumenteAdmin />}
              {gewaehlt === "mitarbeiter" && <MitarbeiterLohnTab />}
              {gewaehlt === "standardwerte" && <LohnStandardwerteCard />}
            </div>
          </div>
        </TrustedDeviceGate>
      )}
    </div>
  );
}
