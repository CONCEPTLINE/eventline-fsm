"use client";

/**
 * Tickets (/tickets) — Bearbeitungs-Ansicht fuer tickets:manage (Sidebar HR ›
 * Tickets). Am Desktop TicketsView (inkl. Kopf/h1, Zurueck-Pfeil bei
 * ?from=dashboard), am Handy tickets-mobil. Alte Links /hr?tab=tickets
 * leitet /hr hierher; Detail: /tickets/[id] (auch fuer die meldende Person).
 *
 * Wer Tickets nicht bearbeitet, sieht seine Meldungen unter Meine Anfragen
 * (/anfragen) — alte Links und Lesezeichen auf /tickets leiten dorthin.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { TicketsView } from "@/components/tickets/tickets-view";
import { TicketsMobil } from "@/components/mobile/tickets-mobil";
import { useIsMobile } from "@/lib/use-is-mobile";
import { usePermissions } from "@/lib/use-permissions";
import Loading from "./loading";

export default function TicketsPage() {
  const router = useRouter();
  const { can, ready } = usePermissions();
  const bearbeitet = can("tickets:manage");
  useEffect(() => {
    if (ready && !bearbeitet) router.replace("/anfragen");
  }, [ready, bearbeitet, router]);

  // Breite unbekannt (nur SSR/Hydration) → neutrales Skelett ohne Effekte,
  // damit TicketsView am Handy nicht kurz mountet (getUser, localStorage).
  const isMobile = useIsMobile();
  if (!ready || !bearbeitet || isMobile === null) return <Loading />;
  if (isMobile) return <TicketsMobil />;
  return <TicketsView />;
}
