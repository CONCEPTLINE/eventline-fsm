"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, CheckCircle2, Plug, X } from "lucide-react";
import { useConfirm } from "@/components/ui/use-confirm";
import { createClient } from "@/lib/supabase/client";
import { IcalFeedBlock } from "@/components/kalender/ical-feed-block";

interface BexioStatus {
  connected: boolean;
  connectedAt?: string;
  bexioEmail?: string | null;
  expiresAt?: string;
  features?: { contacts: boolean };
}

export function IntegrationenTab() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<BexioStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();

  // Role-Check fuer das iCal-Feed-Sektion: nur Admins kriegen den Block
  // hier — fuer sie ist der Token-Filter automatisch der ganze Firma-
  // Kalender. Fuer normale User wuerde der Token nur den eigenen Feed
  // liefern, das ist nicht "Firma" und sie haben den Block jetzt eh
  // direkt auf der /kalender-Page.
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      setIsAdmin(profile?.role === "admin");
    })();
  }, [supabase]);

  // OAuth-Rueckkehr: ?bexio=connected oder ?bexio=error&msg=...
  useEffect(() => {
    const result = searchParams.get("bexio");
    const msg = searchParams.get("msg");
    if (result === "connected") {
      toast.success("Bexio verbunden");
    } else if (result === "error") {
      toast.error("Bexio-Verbindung fehlgeschlagen" + (msg ? `: ${msg}` : ""));
    }
  }, [searchParams]);

  useEffect(() => { loadStatus(); }, []);

  async function loadStatus() {
    setLoading(true);
    try {
      const res = await fetch("/api/bexio/status");
      const json = await res.json();
      setStatus(json);
    } catch {
      setStatus({ connected: false });
    }
    setLoading(false);
  }

  async function handleDisconnect() {
    const ok = await confirm({
      title: "Bexio trennen?",
      message: "Du musst danach neu verbinden, um Kontakte anzulegen.",
      confirmLabel: "Trennen",
      variant: "red",
    });
    if (!ok) return;
    setDisconnecting(true);
    await fetch("/api/bexio/disconnect", { method: "POST" });
    setDisconnecting(false);
    toast.success("Bexio getrennt");
    loadStatus();
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Verknüpfe EVENTLINE mit externen Tools — z.B. Bexio für Kontaktverwaltung
          oder Google Calendar für persönliche Terminübersicht.
        </p>
      </div>

      {/* iCal-Feed Firma — dedizierter Token in app_settings, nicht an
          eine Person gebunden. Vorher war das der persoenliche Admin-Token,
          was strukturell falsch war (Token-Leak = Firma-Sicht-Leak,
          Admin-Deaktivierung = Firma-Feed-Tod). Block nur fuer Admins —
          RLS erlaubt nur ihnen das Lesen des Tokens. */}
      {isAdmin && (
        <IcalFeedBlock
          source="company"
          title="Kalender der Firma (iCal-Feed)"
          description={
            <>
              Dieser Feed enthält <strong>alle Aufträge + Termine</strong> der Firma — unabhängig von einzelnen Mitarbeitern.
              Kopiere die URL und füge sie in Google Calendar / Apple Calendar / Outlook über{" "}
              <span className="font-medium">&quot;Per URL hinzufügen&quot;</span> ein.
            </>
          }
        />
      )}

      <Card className="bg-card border-gray-100">
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-white font-bold shrink-0">
                B
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">Bexio</h3>
                  {loading ? (
                    <span className="text-xs text-muted-foreground">…</span>
                  ) : status?.connected ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Verbunden
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600 dark:bg-gray-500/20 dark:text-gray-300">
                      <AlertCircle className="h-3 w-3" />
                      Nicht verbunden
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Kunden direkt in Bexio anlegen — der &quot;In Bexio anlegen&quot;-Button erscheint dann auf jeder Kunden-Detailseite. Zusätzlich: Rechnungs-Link aus dem Auftrags-Archiv.
                </p>
                {status?.connected && status.connectedAt && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Verbunden seit {new Date(status.connectedAt).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}
                    {status.bexioEmail && <> · {status.bexioEmail}</>}
                  </p>
                )}
              </div>
            </div>
            <div className="shrink-0">
              {loading ? null : status?.connected ? (
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="kasten kasten-muted"
                >
                  <X className="h-3.5 w-3.5" />
                  {disconnecting ? "Trenne…" : "Trennen"}
                </button>
              ) : (
                <a href="/api/bexio/connect" className="kasten kasten-bexio">
                  <Plug className="h-3.5 w-3.5" />
                  Verbinden
                </a>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      {ConfirmModalElement}
    </div>
  );
}
