"use client";

/**
 * Deep-Link-Alias fuer den Ferien-Tab im HR-Hub. Die eigentliche
 * View lebt in src/components/ferien/ferien-view.tsx — sowohl diese
 * Seite als auch /hr?tab=ferien rendern sie. So bleiben bestehende
 * Ferien-Links (Notifications, Bookmarks) erreichbar.
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
