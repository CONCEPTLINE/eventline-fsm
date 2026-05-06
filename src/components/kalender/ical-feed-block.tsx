"use client";

/**
 * iCal-Feed-Block — gemeinsame Card fuer das Anzeigen + Kopieren der
 * persoenlichen Calendar-Feed-URL. Wird auf /kalender (fuer alle User) und
 * in /einstellungen → Integrationen (nur fuer Admins, dort als "Kalender
 * der Firma" weil Admins via Token-Filter eh alle Daten sehen) eingebunden.
 *
 * Lokalisiert nichts — die Card-Texte (title, description, scope) kommen
 * vom Caller damit derselbe Block einmal als "Mein Kalender" und einmal
 * als "Kalender der Firma" auftauchen kann.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Copy, Check, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useConfirm } from "@/components/ui/use-confirm";
import { appUrl } from "@/lib/app-url";

interface Props {
  /** Card-Headline. */
  title: string;
  /** Erklaer-Text unter der Headline. */
  description: React.ReactNode;
  /** "user" = persoenlicher Feed (profiles.calendar_feed_token);
   *  "company" = firmenweiter Feed (app_settings.company_calendar_token).
   *  Default "user" damit die /kalender-Seite nichts anpassen muss. */
  source?: "user" | "company";
}

export function IcalFeedBlock({ title, description, source = "user" }: Props) {
  const supabase = createClient();
  const [icalUrl, setIcalUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();

  async function loadToken() {
    if (typeof window === "undefined") return;
    let token: string | null = null;
    if (source === "company") {
      // app_settings ist Singleton. RLS laesst nur Admins lesen — Block
      // wird im IntegrationenTab ausserdem nur fuer Admins gerendert.
      const { data } = await supabase
        .from("app_settings")
        .select("company_calendar_token")
        .eq("id", 1)
        .maybeSingle();
      token = data?.company_calendar_token ?? null;
    } else {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("calendar_feed_token")
        .eq("id", user.id)
        .maybeSingle();
      token = profile?.calendar_feed_token ?? null;
    }
    if (token) {
      // appUrl() statt window.location.origin — sonst kriegt der User die
      // per-deployment URL ins Calendar-Abo (z.B. eventline-fsm-usyk-
      // h69yfgtq1...) und bleibt fuer immer auf einem alten Build haengen.
      setIcalUrl(`${appUrl()}/api/calendar.ics?token=${token}`);
    }
  }

  useEffect(() => {
    loadToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, source]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(icalUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("URL kopiert");
    } catch {
      toast.error("Kopieren fehlgeschlagen");
    }
  }

  async function rotate() {
    const ok = await confirm({
      title: "Token rotieren?",
      message: source === "company"
        ? "Der alte Firma-Link wird sofort ungültig. Alle Geräte/Personen die diesen Kalender abonniert haben (Geschäftsleitung, Sekretariat, etc.) müssen die neue URL eintragen."
        : "Der alte Link wird sofort ungültig. Du musst die URL neu in deine Calendar-Apps kopieren (Google/Apple/Outlook). Alle anderen Geräte verlieren den Zugang.",
      confirmLabel: "Rotieren",
      variant: "red",
    });
    if (!ok) return;
    // Race-Schutz: alten Link sofort entwerten BEVOR wir den neuen holen.
    // Vorher konnte der User in der kurzen Zeit zwischen Click und Server-
    // Antwort den noch sichtbaren alten Link kopieren — und damit eine
    // bereits invalidierte URL in seiner Calendar-App speichern.
    setIcalUrl("");
    setRotating(true);
    try {
      const endpoint = source === "company"
        ? "/api/company/rotate-calendar-token"
        : "/api/profile/rotate-calendar-token";
      const res = await fetch(endpoint, { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        toast.error(json.error ?? "Rotation fehlgeschlagen");
        return;
      }
      await loadToken();
      toast.success("Token rotiert — bitte neu kopieren");
    } catch {
      toast.error("Rotation fehlgeschlagen");
    } finally {
      setRotating(false);
    }
  }

  return (
    <Card className="bg-card border-gray-100">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500 to-red-500 flex items-center justify-center text-white font-bold shrink-0">
            G
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{title}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {description}
              <br />
              <span className="text-amber-700 dark:text-amber-400">
                {source === "company"
                  ? "Diese URL gibt Zugriff auf den ganzen Firma-Kalender — nicht extern weitergeben."
                  : "Diese URL enthält dein persönliches Token — nicht weitergeben."}
              </span>
            </p>
          </div>
        </div>
        <div className="flex items-stretch gap-2">
          <input
            readOnly
            value={icalUrl}
            onClick={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/40 truncate focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <button
            type="button"
            onClick={copy}
            disabled={!icalUrl}
            className={`kasten ${copied ? "kasten-green" : "kasten-blue"}`}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Kopiert" : "Kopieren"}
          </button>
          <button
            type="button"
            onClick={rotate}
            disabled={!icalUrl || rotating}
            className="kasten kasten-muted"
            data-tooltip="Token rotieren — alter Link wird ungültig"
            data-tooltip-align="end"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${rotating ? "animate-spin" : ""}`} />
          </button>
        </div>
        {ConfirmModalElement}
      </CardContent>
    </Card>
  );
}
