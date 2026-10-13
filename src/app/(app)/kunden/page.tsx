"use client";

/**
 * Kunden — eigener Sidebar-Eintrag in der Gruppe KONTAKTE (vorher Tab im
 * Datenbank-Hub; /datenbank und /datenbank?tab=kunden leiten hierher um).
 *
 * Die View (src/components/kunden/kunden-view.tsx) bringt den kompletten
 * Kopf mit: Titel, Zaehler, Archiv-Umschalter, «Neuer Kunde», dazu Weltkarte,
 * Bexio-Abgleich, Suche + Filter. Detail: /kunden/[id].
 */

import { KundenView } from "@/components/kunden/kunden-view";

export default function KundenPage() {
  return <KundenView />;
}
