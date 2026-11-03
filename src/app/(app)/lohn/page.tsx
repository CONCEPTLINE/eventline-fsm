"use client";

/**
 * Lohn (/lohn) — eigene Seite im Sidebar-Bereich HR. Für alle dieselbe
 * Ansicht (src/components/lohn/mein-lohn.tsx): je Monat Stunden und
 * Lohnabrechnung, Lohnausweis, Zustellung. Gerechnet wird der Lohn in
 * Trust flow; das ERP zeigt die gelieferten PDFs.
 *
 * Alte Links auf die frühere Team-Ansicht (?ansicht=team&tab=…, Mails,
 * Glocke, Lesezeichen): Monatsstunden → Stempelzeiten › Prüfen (mit ?monat=),
 * Lohndokumente/Mitarbeiter-Lohn/Standardwerte → /lohn/verwaltung (befristet).
 * Mit lohn:manage ein dezenter Link auf die Lohnverwaltung (bis Lohnlauf
 * November 2026). Schlüssel: src/components/hr/lohn-bereiche.ts.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Settings } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { MeinLohn } from "@/components/lohn/mein-lohn";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { LOHN_PARAM_ANSICHT, LOHN_PARAM_BEREICH, teamLinkZiel, verwaltungLink } from "@/components/hr/lohn-bereiche";
import { usePermissions } from "@/lib/use-permissions";
import Loading from "./loading";

export default function LohnPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { can, ready } = usePermissions();
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
        {ready && can("lohn:manage") && <VerwaltungLink />}
      </div>
      <MeinLohn />
    </div>
  );
}

/** Dezenter Link auf die befristete Lohnverwaltung (nur lohn:manage). Entfällt in Phase 2. */
function VerwaltungLink() {
  const [hover, setHover] = useState(false);
  return (
    <span className="mt-1.5 shrink-0" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <PrefetchLink
        href={verwaltungLink()}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        style={{ color: hover ? "var(--accent)" : undefined }}
      >
        <Settings className="h-3.5 w-3.5" />
        <span><span className="font-medium">Lohnverwaltung</span> (bis Lohnlauf November 2026)</span>
        <ChevronRight className="h-3.5 w-3.5" />
      </PrefetchLink>
    </span>
  );
}
