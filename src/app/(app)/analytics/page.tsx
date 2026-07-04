"use client";

/**
 * Analytics-Hub — Firmen-Kennzahlen fuer strategische Entscheidungen.
 *
 * Aktuell:
 *   • Lohnsummen-Prognose (Ausgleichskasse / SUVA / BVG-Meldung)
 *
 * Geplant:
 *   • Umsatz-Trend, Kunden-Analyse, Location-Auslastung, ...
 *
 * Admin-only, Trust-gated (nutzt monthly-stats-API die selber
 * requireTrustedDevice("lohn:manage") checkt).
 */

import { usePermissions } from "@/lib/use-permissions";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";
import { LohnsummenPrognose } from "@/components/analytics/lohnsummen-prognose";
import { BarChart3 } from "lucide-react";

export default function AnalyticsPage() {
  const { role, ready } = usePermissions();
  if (!ready) return null;
  const isAdmin = role === "admin";

  if (!isAdmin) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm text-muted-foreground">Nur für Administratoren.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          Analytics
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Firmen-Kennzahlen für strategische Entscheidungen.
        </p>
      </div>

      <TrustedDeviceGate>
        <LohnsummenPrognose />
      </TrustedDeviceGate>
    </div>
  );
}
