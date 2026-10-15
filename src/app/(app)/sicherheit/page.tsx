"use client";

// /sicherheit — App-Sicherheits-Dashboard (Admin-only, Laptop). MONITORING:
// Status-Kacheln, CSP-Verstoesse und Protokolle (Auth-Log, Rechte-Aenderungen,
// Auftrags-Aenderungen). Die ACCOUNT-Sicherheit (eigene Geraete/Logins/Dev-Mode)
// bleibt bewusst als Tab in /einstellungen -> Sicherheit.
// Admin-Gate dreifach: Sidebar (ADMIN_ONLY_PREFIXES), (app)-Layout-Redirect und
// diese Seite selbst; die Daten sind zusaetzlich per RLS/is_admin() geschuetzt.

import { usePermissions } from "@/lib/use-permissions";
import { SicherheitDashboard } from "@/components/sicherheit/sicherheit-dashboard";
import { SicherheitSkelett } from "@/components/sicherheit/skelett";

export default function SicherheitPage() {
  const { role, ready } = usePermissions();
  if (!ready) return <SicherheitSkelett />;
  if (role !== "admin") {
    return (
      <p className="text-sm text-muted-foreground p-6">
        Kein Zugriff — die Sicherheits-Seite ist Admins vorbehalten.
      </p>
    );
  }
  return <SicherheitDashboard />;
}
