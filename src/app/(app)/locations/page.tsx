/**
 * Locations — eigener Sidebar-Eintrag in der Gruppe KONTAKTE.
 *
 * Kopf wie /kunden (h1 + Untertitel, ohne Symbol). Darunter die
 * LocationsView: Zaehler + Anlegen-Knoepfe, Filter Alle | Verwaltungen |
 * Räume + Archiv, Liste. Die Partner-Zugaenge (Logins fuers Partnerportal)
 * sind Konfiguration und leben unter Einstellungen › Partnerportal ›
 * Zugänge (/einstellungen?tab=partner).
 *
 * Detail-Routen bleiben /standorte/[id] und /raeume/[id].
 */

import { LocationsView } from "@/components/locations/locations-view";

export default function LocationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Locations</h1>
        <p className="text-sm text-muted-foreground mt-1">Verwaltungen und Räume</p>
      </div>

      <LocationsView />
    </div>
  );
}
