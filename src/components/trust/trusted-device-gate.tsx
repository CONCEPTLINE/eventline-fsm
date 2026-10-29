"use client";

/**
 * TrustedDeviceGate — Wrapper-Komponente fuer sensible Page-Inhalte
 * (Finanzen, Löhne, Standort-Report).
 *
 *   <TrustedDeviceGate>
 *     <SensibleContent />
 *   </TrustedDeviceGate>
 *
 * Verhalten:
 *   • Lade /api/trust/status
 *   • Wenn trusted: rendere children
 *   • Wenn pending: «wartet auf Freigabe» mit «gültig bis …»
 *   • Wenn abgelaufen (Anfrage älter als 24 h) oder nicht trusted:
 *     Anfrage-Form (Geräte-Name + «Freigabe anfragen»)
 *
 * Regel seit Lohn-Umbau Phase 1: Ein neues Gerät gibt nur der ANDERE Admin
 * oder die Vertretung frei — angemeldet, per Knopf (/geraet-freigabe),
 * innerhalb von 24 h, selbst auf einem vertrauten Gerät. Der Link in der
 * Mail gibt nicht schon beim Öffnen frei. Die Seite pollt nicht; nach der
 * Freigabe «Status neu prüfen» bzw. neu laden.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Shield, ShieldCheck, Clock, Send, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { formatDateTimeFull } from "@/lib/format";

interface TrustStatus {
  trusted: boolean;
  pending: boolean;
  abgelaufen: boolean;
  deviceName?: string;
  gueltigBis?: string | null;
}

export function TrustedDeviceGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<TrustStatus | null>(null);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pruefe, setPruefe] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/trust/status", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error((json?.error as string | undefined) ?? `HTTP ${res.status}`);
      }
      setLadeFehler(false);
      setStatus({
        trusted: !!json.trusted,
        pending: !!json.pending,
        abgelaufen: !!json.abgelaufen,
        deviceName: json.deviceName,
        gueltigBis: json.gueltigBis ?? null,
      });
      // Abgelaufene Anfrage: alten Geräte-Namen für die neue Anfrage vorschlagen.
      if (json.abgelaufen && typeof json.deviceName === "string") {
        setDeviceName((alt) => alt || json.deviceName);
      }
    } catch (e) {
      setLadeFehler(true);
      toast.error(`Geräte-Status konnte nicht geprüft werden: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function neuPruefen() {
    setPruefe(true);
    try {
      await load();
    } finally {
      setPruefe(false);
    }
  }

  async function handleRequest() {
    const name = deviceName.trim();
    if (!name) {
      toast.error("Geräte-Name eingeben");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/trust/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_name: name }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Anfrage fehlgeschlagen");
        return;
      }
      toast.success("Freigabe angefragt — der andere Admin bzw. die Vertretung ist benachrichtigt");
      await load();
    } catch (e) {
      toast.error(`Anfrage fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const neuPruefenKnopf = (
    <button type="button" onClick={neuPruefen} disabled={pruefe} className="kasten kasten-muted">
      {pruefe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {pruefe ? "Wird geprüft …" : "Status neu prüfen"}
    </button>
  );

  if (status === null && !ladeFehler) {
    return (
      <div className="p-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Prüfe Geräte-Vertrauen …
      </div>
    );
  }

  if (status?.trusted) {
    return <>{children}</>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6">
          {status === null ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                <AlertTriangle className="h-5 w-5" />
                <h2 className="font-semibold">Geräte-Status nicht geprüft</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Ob dieses Gerät vertraut ist, liess sich gerade nicht prüfen. Bitte erneut versuchen.
              </p>
              <div className="pt-1">{neuPruefenKnopf}</div>
            </div>
          ) : status.pending ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <Clock className="h-5 w-5" />
                <h2 className="font-semibold">Wartet auf Freigabe</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Der andere Admin oder die Vertretung gibt dieses Gerät in der App frei — angemeldet,
                per Knopf. Danach hat es Zugriff auf Finanzen und Löhne.
              </p>
              <div className="text-xs text-muted-foreground space-y-0.5">
                {status.deviceName && (
                  <p>Geräte-Name: <span className="font-mono">{status.deviceName}</span></p>
                )}
                {status.gueltigBis && (
                  <p>
                    Anfrage gültig bis{" "}
                    <span className="font-medium text-foreground">{formatDateTimeFull(status.gueltigBis)}</span>
                    {" "}— danach neu anfragen.
                  </p>
                )}
              </div>
              <div className="pt-1">{neuPruefenKnopf}</div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Shield className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h2 className="font-semibold">Vertrautes Gerät nötig</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Finanzen und Löhne öffnen sich nur auf vertrauten Geräten. So reicht ein gestohlenes
                Login allein nicht, um sensible Daten zu sehen.
              </p>
              {status.abgelaufen && (
                <div className="flex items-start gap-2 text-sm p-3 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                  <Clock className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>Anfrage abgelaufen (älter als 24 h) — bitte neu anfragen.</span>
                </div>
              )}
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Geräte-Name</label>
                <Input
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="z.B. 'Büro-MacBook' oder 'iPhone Leo'"
                  maxLength={60}
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleRequest}
                  disabled={submitting || !deviceName.trim()}
                  className="kasten kasten-green"
                >
                  {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  {submitting ? "Wird angefragt …" : "Freigabe anfragen"}
                </button>
              </div>
              <div className="flex items-start gap-2 text-xs text-muted-foreground p-3 rounded-lg bg-muted/40 mt-2">
                <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Freigeben kann nur der <strong>andere Admin</strong> oder die <strong>Vertretung</strong> —
                  angemeldet, per Knopf, innerhalb von 24 Stunden und selbst auf einem vertrauten Gerät.
                  Der Link in der Mail gibt nicht schon beim Öffnen frei. Bereits freigegebene Geräte
                  bleiben gültig. Ist niemand erreichbar: Notweg über Mischa (wird protokolliert).
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
