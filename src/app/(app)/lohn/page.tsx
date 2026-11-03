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
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-3 min-w-0">
        {fromDashboard && <BackButton fallbackHref="/dashboard" />}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Lohn</h1>
          <p className="text-sm text-muted-foreground mt-1">Deine Lohnabrechnungen, Lohnausweise und Stunden.</p>
        </div>
      </div>
      {ready && can("lohn:manage") && <VerwaltungLink />}
      <MeinLohn />
    </div>
  );
}

/** Dezenter Link auf die befristete Lohnverwaltung (nur lohn:manage). Entfällt in Phase 2. */
function VerwaltungLink() {
  const [hover, setHover] = useState(false);
  return (
    <p className="-mt-3 text-xs text-muted-foreground" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <PrefetchLink
        href={verwaltungLink()}
        className="underline underline-offset-2"
        style={{ color: hover ? "var(--accent)" : undefined }}
      >
        Lohnverwaltung (bis Lohnlauf November 2026)
      </PrefetchLink>
    </p>
  );
}
