"use client";

/**
 * Tickets & Belege (/tickets) — eigene Seite im Sidebar-Bereich HR.
 * Am Desktop rendert sie TicketsView (inkl. Kopf/h1, Zurueck-Pfeil bei
 * ?from=dashboard), am Handy tickets-mobil. Alte Links /hr?tab=tickets
 * leitet /hr hierher; Detail: /tickets/[id].
 */

import { TicketsView } from "@/components/tickets/tickets-view";
import { TicketsMobil } from "@/components/mobile/tickets-mobil";
import { useIsMobile } from "@/lib/use-is-mobile";
import Loading from "./loading";

export default function TicketsPage() {
  // Breite unbekannt (nur SSR/Hydration) → neutrales Skelett ohne Effekte,
  // damit TicketsView am Handy nicht kurz mountet (getUser, localStorage).
  const isMobile = useIsMobile();
  if (isMobile === null) return <Loading />;
  if (isMobile) return <TicketsMobil />;
  return <TicketsView />;
}
