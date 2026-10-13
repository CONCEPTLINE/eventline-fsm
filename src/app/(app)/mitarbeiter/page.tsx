"use client";

/**
 * Mitarbeiter (/mitarbeiter) — eigene Seite im Sidebar-Bereich HR: die
 * Benutzer-Verwaltung (anlegen, bearbeiten, deaktivieren; frueher
 * Einstellungen › Team, danach Tab im Hub /hr). Inhalt = TeamTab aus
 * src/components/einstellungen/team-tab.tsx.
 *
 * Nur Admins (gleiche Definition wie vorher: role === "admin"). Der Pfad
 * steht in ADMIN_ONLY_PREFIXES (Layout-Guard + Sidebar); die Seite prueft
 * zusaetzlich selbst, wie die anderen Admin-Seiten.
 * Laptop-Seite (Regel «Wer und wo»), keine eigene Handy-Ansicht.
 */

import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { ShieldOff } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { BackButton } from "@/components/ui/back-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import Loading from "./loading";

// Gleiches Lade-Muster wie in den Einstellungen: eigener Chunk, Skeleton als
// Sofort-Feedback (CLAUDE.md §7). Options als Objekt-Literal direkt im
// dynamic()-Aufruf (Next-Compiler liest sie statisch). ssr:false ist ok —
// die Seite ist eine reine Client-Component.
const TeamTab = dynamic(() => import("@/components/einstellungen/team-tab").then((m) => m.TeamTab), {
  ssr: false,
  loading: () => (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64" />
    </div>
  ),
});

export default function MitarbeiterPage() {
  const searchParams = useSearchParams();
  const { role, ready } = usePermissions();

  // Skeleton statt Kein-Zugriff, solange die Rolle laedt — sonst blitzt
  // der Sperr-Zustand kurz auf.
  if (!ready) return <Loading />;

  if (role !== "admin") {
    return (
      <div className="max-w-md mx-auto py-16">
        <EmptyState icon={ShieldOff} title="Kein Zugriff auf Mitarbeiter" description="Diese Seite ist Admins vorbehalten." />
      </div>
    );
  }

  // Zurueck-Pfeil nur, wenn der Weg ueber einen Dashboard-Link kam.
  const fromDashboard = searchParams.get("from") === "dashboard";

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-3 min-w-0">
        {fromDashboard && <BackButton fallbackHref="/dashboard" />}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Mitarbeiter</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Benutzerkonten anlegen, bearbeiten und deaktivieren.
          </p>
        </div>
      </div>

      <TeamTab />
    </div>
  );
}
