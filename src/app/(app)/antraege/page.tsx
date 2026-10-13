"use client";

/**
 * Anträge (/antraege) — eigene Seite im Sidebar-Bereich HR (vorher Tab im
 * Hub /hr). Offene Abwesenheits-Anträge (direkt genehmigen/ablehnen),
 * Stempel-Änderungen und andere Tickets, dazu die Mitarbeiter-Ampel.
 * Inhalt: src/components/hr/antraege-view.tsx.
 *
 * Sichtbar nur fuer wer etwas genehmigen darf: ferien:approve,
 * tickets:manage oder stempelzeiten:see-all (Admin immer, via
 * hasPermission). Der Pfad haengt an keinem Rechte-Modul — der Layout-Guard
 * laesst alle durch, darum prueft die Seite selbst (Kein-Zugriff-Zustand
 * wie die Admin-Seiten). /api/hr/anfragen prueft dieselben Rechte
 * serverseitig.
 */

import { useSearchParams } from "next/navigation";
import { ShieldOff } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { BackButton } from "@/components/ui/back-button";
import { EmptyState } from "@/components/ui/empty-state";
import { AntraegeView } from "@/components/hr/antraege-view";
import Loading from "./loading";

export default function AntraegePage() {
  const searchParams = useSearchParams();
  const { can, ready } = usePermissions();

  // Skeleton statt Kein-Zugriff, solange die Rechte laden — sonst blitzt
  // der Sperr-Zustand kurz auf.
  if (!ready) return <Loading />;

  const darfAntraege = can("ferien:approve") || can("tickets:manage") || can("stempelzeiten:see-all");
  if (!darfAntraege) {
    return (
      <div className="max-w-md mx-auto py-16">
        <EmptyState
          icon={ShieldOff}
          title="Kein Zugriff auf Anträge"
          description="Diese Seite ist für alle, die Abwesenheiten, Tickets oder Stempelzeiten genehmigen."
        />
      </div>
    );
  }

  // Zurueck-Pfeil nur, wenn der Weg ueber einen Dashboard-Link kam
  // (?from=dashboard, z.B. Kachel «Abwesenheits-Anträge»).
  const fromDashboard = searchParams.get("from") === "dashboard";

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-3 min-w-0">
        {fromDashboard && <BackButton fallbackHref="/dashboard" />}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Anträge</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Abwesenheiten, Stempel-Änderungen und Tickets prüfen — und wer gerade arbeitet.
          </p>
        </div>
      </div>

      <AntraegeView />
    </div>
  );
}
