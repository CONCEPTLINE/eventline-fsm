/**
 * Lieferanten — eigener Sidebar-Eintrag in der Gruppe KONTAKTE (vorher Tab
 * im Datenbank-Hub; /datenbank?tab=lieferanten leitet hierher um).
 *
 * Kopf wie /kunden (h1 + Untertitel, ohne Symbol). Darunter die
 * LieferantenView: Such-Zeile mit «Neuer Lieferant», Liste. Die
 * Lieferanten-Zugaenge (Logins fuers Lieferantenportal inkl. Kataloge) sind
 * Konfiguration und leben unter Einstellungen › Lieferantenportal ›
 * Zugänge (/einstellungen?tab=lieferant).
 */

import { LieferantenView } from "@/components/lieferanten/lieferanten-view";

export default function LieferantenPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Lieferanten</h1>
        <p className="text-sm text-muted-foreground mt-1">Catering, Technik, AV</p>
      </div>

      <LieferantenView />
    </div>
  );
}
