/**
 * Lieferanten — eigener Sidebar-Eintrag in der Gruppe KONTAKTE (vorher Tab
 * im Datenbank-Hub; /datenbank?tab=lieferanten leitet hierher um).
 *
 * Kopf wie /kunden (h1 + Untertitel, ohne Symbol). Darunter die
 * LieferantenView: Such-Zeile mit «Neuer Lieferant», Karten. Je Lieferant
 * wird hier auch der Mietkatalog gepflegt (Katalog-Fenster). Die Portal-
 * Zugaenge (Logins fuers Lieferantenportal) sind Konfiguration und leben
 * unter Einstellungen › Lieferantenportal › Zugänge (/einstellungen?tab=
 * lieferant) — die Karte verlinkt dorthin.
 */

import { LieferantenView } from "@/components/lieferanten/lieferanten-view";

export default function LieferantenPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Lieferanten</h1>
        <p className="text-sm text-muted-foreground mt-1">Firmen, die für EVENTLINE liefern — Kontakte, Kataloge und Portal-Zugänge.</p>
      </div>

      <LieferantenView />
    </div>
  );
}
