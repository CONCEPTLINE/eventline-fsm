"use client";

/**
 * Deep-Link-Alias fuer den Stempelzeiten-Tab im HR-Hub. Die eigentliche
 * View lebt in src/components/stempelzeiten/stempelzeiten-view.tsx —
 * sowohl diese Seite als auch /hr?tab=stempelzeiten rendern sie. So
 * bleibt /stempelzeiten als Deep-Link (z.B. aus Notifications) erreichbar
 * ohne den Inhalt zu duplizieren.
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
