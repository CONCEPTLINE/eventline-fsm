"use client";

/**
 * Stempelzeiten (/stempelzeiten) — eigene Seite im Sidebar-Bereich HR.
 * Am Desktop rendert sie StempelzeitenView (inkl. Kopf/h1, Zurueck-Pfeil
 * bei ?from=dashboard); alte Links /hr?tab=stempelzeiten leitet /hr hierher.
 *
 * Mit Lohnrecht (lohn:manage) zwei Reiter (TabsNav): «Meine» (die Stempel-
 * Liste) und «Prüfen» (Stunden des Teams vor der Lohnabrechnung in Trust flow,
 * früher Lohn › Monatsstunden; nur auf einem vertrauten Gerät). Reiter in der
 * URL: ?ansicht=pruefen (&monat=YYYY-MM), überlebt Reload (CLAUDE.md §10).
 * «Prüfen» ist eine Laptop-Seite.
 *
 * Am Handy (< md) rendert die Seite die Monatsliste (stempelzeiten-mobil).
 * Breite unbekannt (nur SSR/Hydration) → neutrales Skelett ohne Effekte,
 * damit kein Baum mountet, der gleich wieder ausgetauscht wird.
 */

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Clock, ListChecks } from "lucide-react";
import { StempelzeitenView } from "@/components/stempelzeiten/stempelzeiten-view";
import { StempelPruefen } from "@/components/stempelzeiten/stempel-pruefen";
import { StempelzeitenMobil } from "@/components/mobile/stempelzeiten-mobil";
import { TabsNav } from "@/components/ui/tabs-nav";
import { BackButton } from "@/components/ui/back-button";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";
import { STEMPEL_ANSICHT_PRUEFEN, STEMPEL_PARAM_ANSICHT } from "@/components/hr/lohn-bereiche";
import { useIsMobile } from "@/lib/use-is-mobile";
import { usePermissions } from "@/lib/use-permissions";
import Loading from "./loading";

type Reiter = "meine" | "pruefen";
const REITER = [
  { key: "meine", label: "Meine", icon: <Clock className="h-4 w-4" /> },
  { key: "pruefen", label: "Prüfen", icon: <ListChecks className="h-4 w-4" /> },
];

export default function StempelzeitenPage() {
  const isMobile = useIsMobile();
  const searchParams = useSearchParams();
  const { can, ready } = usePermissions();
  const urlReiter: Reiter = searchParams.get(STEMPEL_PARAM_ANSICHT) === STEMPEL_ANSICHT_PRUEFEN ? "pruefen" : "meine";
  // Klick wirkt sofort; eine von aussen geänderte URL gewinnt wieder (Abgleich beim Rendern).
  const [gewaehlt, setGewaehlt] = useState<Reiter>(urlReiter);
  const [gesehen, setGesehen] = useState<Reiter>(urlReiter);
  if (urlReiter !== gesehen) {
    setGesehen(urlReiter);
    setGewaehlt(urlReiter);
  }

  if (isMobile === null) return <Loading />;
  if (isMobile) return <StempelzeitenMobil />;
  if (!ready) return <Loading />;

  const darfPruefen = can("lohn:manage");
  const reiter: Reiter = darfPruefen ? gewaehlt : "meine";

  function waehle(k: string) {
    const r: Reiter = k === "pruefen" ? "pruefen" : "meine";
    setGewaehlt(r);
    const url = new URL(window.location.href);
    if (r === "pruefen") url.searchParams.set(STEMPEL_PARAM_ANSICHT, STEMPEL_ANSICHT_PRUEFEN);
    else {
      url.searchParams.delete(STEMPEL_PARAM_ANSICHT);
      url.searchParams.delete("monat");
    }
    window.history.replaceState(window.history.state, "", url.toString());
  }

  const tabs = darfPruefen ? <TabsNav tabs={REITER} active={reiter} onChange={waehle} ariaLabel="Stempelzeiten-Ansicht" /> : null;

  if (reiter === "meine") return <StempelzeitenView tabs={tabs} />;

  const fromDashboard = searchParams.get("from") === "dashboard";
  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-3 min-w-0 min-h-9">
        {fromDashboard && <BackButton fallbackHref="/dashboard" />}
        <h1 className="text-2xl font-bold tracking-tight">Stempelzeiten</h1>
      </div>
      {tabs}
      <TrustedDeviceGate>
        <StempelPruefen />
      </TrustedDeviceGate>
    </div>
  );
}
