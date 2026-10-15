"use client";

/**
 * Finanzen (/finanzen) — Blick-Dashboard aus dem Bexio-Spiegel: Abgleich-
 * Status, Kennzahlen, Umsatz pro Monat, Bankkonten, offene Debitoren/
 * Kreditoren. Desktop ohne Seiten-Scroll (Raster in FinanzenUebersicht).
 *
 * Welle 1 ist admin-only (ADMIN_ONLY_PREFIXES + requireAdminTrustedDevice in
 * den Routen); das Recht finanzen:view ist Dokumentation. Innen das Gate
 * «vertrautes Geraet» (TrustedDeviceGate). Die Daten laedt FinanzenUebersicht
 * erst hinter dem Gate — ohne vertrautes Geraet geht kein Fetch raus.
 *
 * Buero-Seite: am Handy zeigt die Shell automatisch den Hinweis-Balken.
 */

import { BarChart3 } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { EmptyState } from "@/components/ui/empty-state";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";
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
    <TrustedDeviceGate>
      <FinanzenUebersicht />
    </TrustedDeviceGate>
  );
}
