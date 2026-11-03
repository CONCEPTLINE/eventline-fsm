"use client";

/**
 * Lohn (/lohn) — eigene Seite im Sidebar-Bereich HR. Für alle dieselbe
 * Ansicht (src/components/lohn/mein-lohn.tsx): je Monat Stunden und
 * Lohnabrechnung, Lohnausweis, Zustellung. Gerechnet wird der Lohn in
 * Trust flow; das ERP zeigt die gelieferten PDFs.
 *
 * Alte Links auf die frühere Team-Ansicht (?ansicht=team&tab=…, Mails,
 * Glocke, Lesezeichen) landen auf Stempelzeiten › Prüfen (mit ?monat=).
 * Schlüssel: src/components/hr/lohn-bereiche.ts.
 */

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { MeinLohn } from "@/components/lohn/mein-lohn";
import { LOHN_PARAM_ANSICHT, teamLinkZiel } from "@/components/hr/lohn-bereiche";
import Loading from "./loading";

export default function LohnPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const teamZiel = searchParams.get(LOHN_PARAM_ANSICHT) === "team" ? teamLinkZiel(searchParams.get("monat")) : null;

  useEffect(() => {
    if (teamZiel) router.replace(teamZiel);
  }, [teamZiel, router]);

  if (teamZiel) return <Loading />;

  // Zurueck-Pfeil nur, wenn der Weg ueber einen Dashboard-Link kam (?from=dashboard).
  const fromDashboard = searchParams.get("from") === "dashboard";

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-3 min-w-0">
        {fromDashboard && <BackButton fallbackHref="/dashboard" />}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Lohn</h1>
          <p className="text-sm text-muted-foreground mt-1">Deine Lohnabrechnungen, Lohnausweise und Stunden.</p>
        </div>
      </div>
      <MeinLohn />
    </div>
  );
}
