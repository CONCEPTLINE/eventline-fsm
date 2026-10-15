"use client";

/**
 * Sicherheit-Tab — Einstellungen › Firmenportal › Sicherheit, nur Admin.
 * Seit dem Sicherheits-Dashboard (2026-10-15) nur noch zwei Karten:
 *   Entwickler-Modus  «Ansicht als» + aktueller Build
 * Anmeldungen (intern), Vertraute Geräte, CSP-Verstösse und die Protokolle
 * sind umgezogen nach /sicherheit (App-Sicherheits-Dashboard, Nav System →
 * Sicherheit) — dort als Tabs statt als gestapelte Karten, kein Doppel mehr.
 * Die Anmeldungen der Partner und Lieferanten bleiben in deren Portal
 * (Partnerportal › Anmeldungen, Lieferantenportal › Anmeldungen).
 */

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { DeveloperModeCard } from "@/components/einstellungen/developer-mode-card";
import { BuildInfoBadge } from "@/components/einstellungen/build-info-badge";

export function SicherheitTab() {
  return (
    <div className="space-y-6">
      <Link
        href="/sicherheit"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        App-weite Sicherheit (CSP, Anmeldungen, vertraute Geräte, Protokolle) → Sicherheit-Dashboard
      </Link>

      <section className="space-y-3">
        <DeveloperModeCard />
        <div className="flex">
          <BuildInfoBadge />
        </div>
      </section>
    </div>
  );
}
