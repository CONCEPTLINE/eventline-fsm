"use client";

/**
 * Lohn (/lohn) — eigene Seite im Sidebar-Bereich HR. Für alle dieselbe
 * Ansicht (src/components/lohn/mein-lohn.tsx): je Monat Stunden und
 * Lohnabrechnung, Lohnausweis, Zustellung. Gerechnet wird der Lohn in
 * Trust flow; das ERP zeigt die gelieferten PDFs.
 *
 * Alte Links auf die frühere Team-Ansicht (?ansicht=team&tab=…, Mails,
 * Glocke, Lesezeichen): Monatsstunden → Stempelzeiten › Prüfen (mit ?monat=),
 * frühere Verwaltungs-Reiter → /lohn. Schlüssel: src/components/hr/lohn-bereiche.ts.
 */

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { MeinLohn } from "@/components/lohn/mein-lohn";
import { LOHN_PARAM_ANSICHT, LOHN_PARAM_BEREICH, teamLinkZiel } from "@/components/hr/lohn-bereiche";
import Loading from "./loading";

export default function LohnPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const teamZiel = searchParams.get(LOHN_PARAM_ANSICHT) === "team"
    ? teamLinkZiel(searchParams.get(LOHN_PARAM_BEREICH), searchParams.get("monat"))
    : null;

  useEffect(() => {
    if (teamZiel) router.replace(teamZiel);
  }, [teamZiel, router]);

  if (teamZiel) return <Loading />;

  // Zurueck-Pfeil nur, wenn der Weg ueber einen Dashboard-Link kam (?from=dashboard).
  const fromDashboard = searchParams.get("from") === "dashboard";

  return (
    <div className="space-y-5 page-enter">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 max-w-[880px]">
        <div className="flex items-start gap-3 min-w-0">
          {fromDashboard && <BackButton fallbackHref="/dashboard" />}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">Lohn</h1>
            <p className="text-sm text-muted-foreground mt-1">Deine Lohnabrechnungen, Lohnausweise und Stunden.</p>
          </div>
        </div>
      </div>
      <MeinLohn />
    </div>
  );
}
