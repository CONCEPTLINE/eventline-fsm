"use client";

/**
 * Persoenliche Konto-Karte fuer /einstellungen — Datenschutz-Link und
 * Daten-Export. Sichtbar fuer alle Rollen, da Auskunftsrecht jedem User
 * zusteht (revDSG / DSGVO).
 */

import { useState } from "react";
import { todayLocalIso } from "@/lib/swiss-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, Download, User } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

export function MeinKontoCard() {
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/profile/export-data", { method: "GET" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "Export fehlgeschlagen");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eventline-meine-daten-${todayLocalIso()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export heruntergeladen");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <User className="h-4 w-4" />Mein Konto
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Datenschutz-Erklärung einsehen oder eine Kopie deiner gespeicherten
          Daten als JSON herunterladen.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/datenschutz"
            target="_blank"
            rel="noopener noreferrer"
            className="kasten kasten-muted max-md:min-h-[34px]"
          >
            <Shield className="h-3.5 w-3.5" />
            Datenschutzerklärung
          </Link>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="kasten kasten-blue max-md:min-h-[34px]"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Lädt…" : "Meine Daten exportieren"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
