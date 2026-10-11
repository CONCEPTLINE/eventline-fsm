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

export default function TicketsPage() {
  // null (Breite noch unbekannt) rendert den Desktop-Baum — kein Doppel-Render.
  const isMobile = useIsMobile();
  if (isMobile === true) return <TicketsMobil />;
  return <TicketsView />;
}
