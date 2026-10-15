"use client";

/**
 * Finanzen (/finanzen) — Uebersicht aus dem Bexio-Spiegel: Abgleich-Status,
 * Kennzahlen, Umsatz pro Monat, offene Debitoren/Kreditoren, Bankkonten.
 *
 * Welle 1 ist admin-only (ADMIN_ONLY_PREFIXES + requireAdminTrustedDevice in
 * den Routen); das Recht finanzen:view ist Dokumentation. Innen zwei Gates:
 * vertrautes Geraet (TrustedDeviceGate) und Step-up (StepUpGate, 15 min
 * absolut, 10 min Inaktivitaet). Die Daten laedt FinanzenUebersicht erst
 * hinter beiden Gates — ohne Bestaetigung geht kein Fetch raus.
 *
 * Buero-Seite: am Handy zeigt die Shell automatisch den Hinweis-Balken.
 */

import { BarChart3 } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { EmptyState } from "@/components/ui/empty-state";
// VORSCHAU: TrustedDeviceGate und StepUpGate voruebergehend ausgehaengt (siehe
// src/lib/finanzen/auth.ts, VORSCHAU_GERAET_PLATZHALTER) — vor Merge zurueck:
//   <TrustedDeviceGate><StepUpGate><FinanzenUebersicht /></StepUpGate></TrustedDeviceGate>
import { FinanzenUebersicht } from "@/components/finanzen/uebersicht";
import { FINANZEN_PERMISSION } from "@/lib/finanzen/types";
import Loading from "./loading";

export default function FinanzenPage() {
  const { can, role, ready } = usePermissions();

  if (!ready) return <Loading />;

  if (role !== "admin" || !can(FINANZEN_PERMISSION)) {
    return (
      <EmptyState
        icon={BarChart3}
        title="Nur für Administratoren"
        description="Finanzen sind in dieser Ausbaustufe auf Administratoren beschränkt."
      />
    );
  }

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-3 min-w-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Finanzen</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Offene Posten, Umsatz und Bankkonten aus Bexio. Vorschau: Gerätesperre und Bestätigung vorübergehend aus.
          </p>
        </div>
      </div>

      <FinanzenUebersicht />
    </div>
  );
}
