"use client";

/**
 * Deep-Link-Alias fuer den Tickets-Tab im HR-Hub. Die eigentliche
 * View lebt in src/components/tickets/tickets-view.tsx — sowohl diese
 * Seite als auch /hr?tab=tickets rendern sie. So bleibt /tickets als
 * Deep-Link (z.B. aus Mail-Notifications) erreichbar.
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
