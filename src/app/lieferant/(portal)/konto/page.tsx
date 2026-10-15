"use client";

/**
 * Lieferanten-Konto-Seite — Spiegel der Partner-Konto-Seite: eigene Daten
 * ansehen, Benachrichtigungen (Kanal-Matrix), Datenschutz-Status, -Export
 * und -Erklaerung. Bewusst minimal: kein Profil-Edit (Name/E-Mail aendert
 * EVENTLINE), keine Passwort-Aenderung hier (Reset-Mail auf /lieferant/login).
 *
 * Daten ueber /api/lieferant/konto: das Portal liest weder lieferanten noch
 * fremde profiles im Browser, und die «Ansicht als» zeigt die angesehene
 * Person (nicht den Admin). Ab Laptop-Breite zweispaltig (links Profil +
 * Datenschutz, rechts Benachrichtigungen) — so passt die Seite ohne Scrollen,
 * auch wenn die Kanal-Matrix um Ereignisse waechst.
 */

import { useCallback, useEffect, useState } from "react";
import { todayLocalIso } from "@/lib/swiss-time";
import { formatDateFull } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { PartnerNotificationsCard } from "@/components/partner/partner-notifications-card";
import { AlertTriangle, Download, Loader2, RotateCw, Shield, User as UserIcon } from "lucide-react";
import { toast } from "sonner";

interface Konto {
  full_name: string;
  email: string;
  firma_name: string | null;
  datenschutz_akzeptiert_at: string | null;
  datenschutz_akzeptiert_version: string | null;
}

type Laden = { status: "laedt" } | { status: "fehler" } | { status: "ok"; konto: Konto };

export default function LieferantKontoPage() {
  const [laden, setLaden] = useState<Laden>({ status: "laedt" });
  const [exporting, setExporting] = useState(false);

  // Setzt nur Ergebnis/Fehler; den Lade-Zustand setzt der Aufrufer (Start =
  // Initialwert, «Erneut laden» = Klick) — kein synchrones setState im Effekt.
  const kontoLaden = useCallback(async () => {
    try {
      const res = await fetch("/api/lieferant/konto", { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Konto konnte nicht geladen werden");
      setLaden({ status: "ok", konto: j.konto as Konto });
    } catch (e) {
      setLaden({ status: "fehler" });
      toast.error(e instanceof Error ? e.message : "Konto konnte nicht geladen werden");
    }
  }, []);
  useEffect(() => { void kontoLaden(); }, [kontoLaden]);

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
    } catch {
      toast.error("Export fehlgeschlagen — bitte nochmals versuchen");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4 page-enter">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Mein Konto</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Deine Profildaten, Benachrichtigungen und Datenschutz-Optionen.
        </p>
      </div>

      {laden.status === "laedt" ? (
        <div className="grid gap-4 lg:grid-cols-2 items-start">
          <div className="space-y-4">
            <Skeleton className="h-44 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
          <Skeleton className="h-72 rounded-xl" />
        </div>
      ) : laden.status === "fehler" ? (
        <Card className="bg-card">
          <EmptyState
            icon={AlertTriangle}
            title="Konto konnte nicht geladen werden"
            description="Bitte versuche es nochmals. Bleibt der Fehler, melde dich bei EVENTLINE."
            action={
              <button type="button" onClick={() => { setLaden({ status: "laedt" }); void kontoLaden(); }} className="kasten kasten-muted">
                <RotateCw className="h-3.5 w-3.5" /> Erneut laden
              </button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 items-start">
          <div className="space-y-4 min-w-0">
            <Card className="bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <UserIcon className="h-4 w-4" />Profil
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="Name" value={laden.konto.full_name} />
                <Row label="E-Mail" value={laden.konto.email} />
                <Row label="Firma" value={laden.konto.firma_name ?? "—"} />
                <p className="text-[11px] text-muted-foreground pt-2">
                  Änderungen an Name oder E-Mail bitte direkt an EVENTLINE melden.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Shield className="h-4 w-4" />Datenschutz
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {laden.konto.datenschutz_akzeptiert_at ? (
                  <p className="text-xs text-muted-foreground">
                    Akzeptiert am {formatDateFull(laden.konto.datenschutz_akzeptiert_at)}
                    {laden.konto.datenschutz_akzeptiert_version && ` (Version ${laden.konto.datenschutz_akzeptiert_version})`}
                  </p>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-300">Noch nicht akzeptiert</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <PrefetchLink
                    href="/datenschutz"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="kasten kasten-muted"
                  >
                    <Shield className="h-3.5 w-3.5" />
                    Erklärung ansehen
                  </PrefetchLink>
                  <button
                    type="button"
                    onClick={handleExport}
                    disabled={exporting}
                    className="kasten kasten-blue"
                  >
                    {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    {exporting ? "Wird exportiert…" : "Meine Daten exportieren"}
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Der Export enthält alle zu deinem Konto gespeicherten Daten
                  im JSON-Format.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Kanal-Matrix (E-Mail/Push pro Ereignis) — gleiche Karte wie im
              Partnerportal, mit den Lieferanten-Ereignissen. */}
          <div className="min-w-0">
            <PartnerNotificationsCard audience="lieferant" />
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground w-20 shrink-0">{label}</span>
      {/* min-w-0 + break-words: eine lange E-Mail bricht um statt ueberzulaufen. */}
      <span className="font-medium min-w-0 break-words">{value}</span>
    </div>
  );
}
