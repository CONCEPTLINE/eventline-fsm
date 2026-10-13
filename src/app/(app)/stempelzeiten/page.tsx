"use client";

/**
 * Stempelzeiten (/stempelzeiten) — eigene Seite im Sidebar-Bereich HR.
 * Am Desktop rendert sie StempelzeitenView (inkl. Kopf/h1, Zurueck-Pfeil
 * bei ?from=dashboard); alte Links /hr?tab=stempelzeiten leitet /hr hierher.
 *
 * Am Handy (< md) rendert die Seite die Monatsliste (stempelzeiten-mobil).
 * Breite unbekannt (nur SSR/Hydration) → neutrales Skelett ohne Effekte,
 * damit kein Baum mountet, der gleich wieder ausgetauscht wird.
 */

import { StempelzeitenView } from "@/components/stempelzeiten/stempelzeiten-view";
import { StempelzeitenMobil } from "@/components/mobile/stempelzeiten-mobil";
import { useIsMobile } from "@/lib/use-is-mobile";
import Loading from "./loading";

export default function StempelzeitenPage() {
  const isMobile = useIsMobile();
  if (isMobile === null) return <Loading />;
  if (isMobile) return <StempelzeitenMobil />;
  return <StempelzeitenView />;
}
