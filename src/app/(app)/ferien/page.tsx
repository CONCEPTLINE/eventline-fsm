"use client";

/**
 * Abwesenheit (/ferien) — eigene Seite im Sidebar-Bereich HR.
 * Am Desktop rendert sie FerienView (inkl. Kopf/h1, Zurueck-Pfeil bei
 * ?from=dashboard); alte Links /hr?tab=ferien leitet /hr hierher.
 *
 * Am Handy (< md) rendert die Seite die Handy-Variante (ferien-mobil).
 * Breite unbekannt (nur SSR/Hydration) → neutrales Skelett ohne Effekte,
 * damit kein Baum mountet, der gleich wieder ausgetauscht wird.
 */

import { FerienView } from "@/components/ferien/ferien-view";
import { FerienMobil } from "@/components/mobile/ferien-mobil";
import { useIsMobile } from "@/lib/use-is-mobile";
import Loading from "./loading";

export default function FerienPage() {
  const isMobile = useIsMobile();
  if (isMobile === null) return <Loading />;
  if (isMobile) return <FerienMobil />;
  return <FerienView />;
}
