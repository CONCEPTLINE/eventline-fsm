"use client";

// Technik-Dashboard (Mischa 2026-10-12): Rig, lokale KI und NAS als digitaler Zwilling.
// Admin-only: die Sidebar zeigt den Eintrag nur Admins (ADMIN_ONLY_PREFIXES), das (app)-Layout
// leitet Nicht-Admins um, die Seite gated zusaetzlich selbst, API (requireAdmin) und RLS sichern die Daten.
// Vertrag: docs/technik-dashboard/VERTRAG.md §6. Tabs «Übersicht» (Dashboard) und «Wissen» (Firmenwissen der KI,
// Migration 344) in technik-seite.tsx.

import { usePermissions } from "@/lib/use-permissions";
import { TechnikSeite } from "@/components/technik-dashboard/technik-seite";
import { TechnikSkelett } from "@/components/technik-dashboard/skelett";

export default function TechnikPage() {
  const { role, ready } = usePermissions();
  if (!ready) return <TechnikSkelett />;
  if (role !== "admin") {
    return <p className="text-sm text-muted-foreground p-6">Kein Zugriff — die Technik-Seite ist Admins vorbehalten.</p>;
  }
  return <TechnikSeite />;
}
