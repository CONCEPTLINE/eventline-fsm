"use client";

/**
 * StepUpGate — zweite Huelle um /finanzen (innerhalb TrustedDeviceGate):
 *
 *   <TrustedDeviceGate><StepUpGate>…</StepUpGate></TrustedDeviceGate>
 *
 * Verhalten (Spec C.B2 Schritt 5):
 *   • laedt /api/finanzen/stepup/status (entprellt: parallele Aufrufe
 *     teilen EINE Promise — sechs Gate-Events erzeugen einen Request)
 *   • bestaetigt → children + zwei Timer: absoluter Ablauf (bisUnix) und
 *     Inaktivitaet STEPUP_INAKTIV_MS (→ POST stepup/ende, Toast, Formular)
 *   • grund "impersonation" → Hinweis ohne Formular
 *   • 403 ohne Gate-Slug (z. B. «Nur fuer Administratoren») → Endzustand
 *     ohne Buttons, ohne Toast, ohne Schleife
 *   • sonst Card «Finanzen freischalten»: Passkey (wenn registriert und
 *     Browser kann WebAuthn) + Passwort-Zeile; Enter im Feld = absenden
 *     (eigener Handler mit preventDefault, Enter=Tab-Regel)
 *   • hoert auf FINANZEN_GATE_EVENT (finanzenFetch) und laedt den Status neu
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Fingerprint, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import {
  FINANZEN_FEHLER,
  FINANZEN_GATE_EVENT,
  STEPUP_INAKTIV_MS,
  STEPUP_PASSWORT_MAX,
  istGateSlug,
  type FinanzenGateEventDetail,
  type StepUpStatusAntwort,
} from "@/lib/finanzen/types";

const NICHT_BESTAETIGT: StepUpStatusAntwort = { success: true, bestaetigt: false, bisUnix: null, passkeys: 0, grund: null };

interface FehlerJson {
  error?: unknown;
  message?: unknown;
}

function fehlerText(json: FehlerJson | null, fallback: string): string {
  if (json && typeof json.message === "string" && json.message) return json.message;
  if (json && typeof json.error === "string" && json.error) return json.error;
  return fallback;
}

export function StepUpGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<StepUpStatusAntwort | null>(null);
  const [endzustand, setEndzustand] = useState<string | null>(null);
  const [gesperrtText, setGesperrtText] = useState<string | null>(null);
  const [passwort, setPasswort] = useState("");
  const [passkeyLaeuft, setPasskeyLaeuft] = useState(false);
  const [passwortLaeuft, setPasswortLaeuft] = useState(false);
  // Lazy-Init mit window-Guard: der Knopf erscheint erst nach dem Status-
  // Fetch (client-only), also kein Hydration-Unterschied.
  const [webauthn] = useState(() => typeof window !== "undefined" && browserSupportsWebAuthn());
  const laufend = useRef<Promise<void> | null>(null);

  const load = useCallback((): Promise<void> => {
    if (laufend.current) return laufend.current;
    const p = (async () => {
      try {
        const res = await fetch("/api/finanzen/stepup/status", { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as (StepUpStatusAntwort & FehlerJson) | FehlerJson | null;
        if (res.ok && json && (json as StepUpStatusAntwort).success === true) {
          setEndzustand(null);
          setStatus(json as StepUpStatusAntwort);
          return;
        }
        if (res.status === 403 && !istGateSlug(json?.error)) {
          // Kein Gate-Slug → kein Formular, kein Toast, keine Schleife.
          setEndzustand(fehlerText(json, "Nur für Administratoren"));
          return;
        }
        toast.error(fehlerText(json, "Freigabe-Status konnte nicht geladen werden"), { id: "stepup-status" });
        setStatus(NICHT_BESTAETIGT);
      } catch {
        toast.error("Freigabe-Status konnte nicht geladen werden", { id: "stepup-status" });
        setStatus(NICHT_BESTAETIGT);
      } finally {
        laufend.current = null;
      }
    })();
    laufend.current = p;
    return p;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Gate-Events von finanzenFetch: stepup_required / stepup_impersonation →
  // Status neu laden. device_not_trusted macht finanzenFetch selbst (Reload).
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<FinanzenGateEventDetail>).detail;
      if (detail?.slug === FINANZEN_FEHLER.STEPUP_REQUIRED || detail?.slug === FINANZEN_FEHLER.STEPUP_IMPERSONATION) {
        void load();
      }
    };
    window.addEventListener(FINANZEN_GATE_EVENT, handler);
    return () => window.removeEventListener(FINANZEN_GATE_EVENT, handler);
  }, [load]);

  const bestaetigt = status?.bestaetigt === true;
  const bisUnix = status?.bisUnix ?? null;

  // Zwei Timer, nur solange bestaetigt: (a) absoluter Ablauf des Tickets,
  // (b) Inaktivitaet auf /finanzen (nur hier — (app)/layout bleibt unangetastet).
  useEffect(() => {
    if (!bestaetigt) return;
    const ablauf = window.setTimeout(() => { void load(); }, Math.max(0, (bisUnix ?? 0) * 1000 - Date.now()));

    let inaktiv: number | undefined;
    const sperren = async () => {
      try {
        await fetch("/api/finanzen/stepup/ende", { method: "POST" });
      } catch {
        // Cookie laeuft spaetestens mit dem Ticket ab — der Status-Fetch
        // nach dem Formular entscheidet ohnehin serverseitig.
      }
      toast("Finanzen nach 10 Minuten ohne Eingabe gesperrt", { id: "stepup-inaktiv" });
      setStatus((s) => (s ? { ...s, bestaetigt: false, bisUnix: null, grund: "abgelaufen" } : s));
    };
    const reset = () => {
      window.clearTimeout(inaktiv);
      inaktiv = window.setTimeout(() => { void sperren(); }, STEPUP_INAKTIV_MS);
    };
    const events = ["mousedown", "keydown", "scroll", "touchstart"] as const;
    // capture: true, damit auch Scroll in inneren Containern zaehlt.
    events.forEach((e) => window.addEventListener(e, reset, { passive: true, capture: true }));
    reset();

    return () => {
      window.clearTimeout(ablauf);
      window.clearTimeout(inaktiv);
      events.forEach((e) => window.removeEventListener(e, reset, true));
    };
  }, [bestaetigt, bisUnix, load]);

  function fehlerAnzeigen(resStatus: number, json: FehlerJson | null) {
    const msg = fehlerText(json, "Bestätigung fehlgeschlagen");
    toast.error(msg, { id: "stepup" });
    if (resStatus === 429 && json?.error === FINANZEN_FEHLER.STEPUP_GESPERRT) setGesperrtText(msg);
    if (istGateSlug(json?.error)) void load();
  }

  function bestaetigtSetzen(bisUnixNeu: number) {
    setGesperrtText(null);
    setPasswort("");
    setStatus((s) => ({ success: true, bestaetigt: true, bisUnix: bisUnixNeu, passkeys: s?.passkeys ?? 0, grund: null }));
  }

  async function mitPasskey() {
    if (passkeyLaeuft || passwortLaeuft) return;
    setPasskeyLaeuft(true);
    try {
      const chRes = await fetch("/api/finanzen/stepup/passkey-challenge", { method: "POST" });
      const chJson = (await chRes.json().catch(() => null)) as ({ success?: boolean; options?: unknown } & FehlerJson) | null;
      if (!chRes.ok || !chJson?.success) {
        fehlerAnzeigen(chRes.status, chJson);
        return;
      }
      let authResp;
      try {
        authResp = await startAuthentication({ optionsJSON: chJson.options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
      } catch (e) {
        // Abbruch durch User oder kein passender Passkey am Geraet — still.
        // Browser werfen dafuer NotAllowedError («The operation either timed
        // out or was not allowed…»), SimpleWebAuthn ERROR_CEREMONY_ABORTED.
        const msg = e instanceof Error ? e.message : "Abgebrochen";
        const name = e instanceof Error ? e.name : "";
        const code = (e as { code?: unknown } | null)?.code;
        if (name === "NotAllowedError" || code === "ERROR_CEREMONY_ABORTED" || /cancel|abort/i.test(msg)) return;
        toast.error(msg, { id: "stepup" });
        return;
      }
      const vRes = await fetch("/api/finanzen/stepup/passkey-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: authResp }),
      });
      const vJson = (await vRes.json().catch(() => null)) as ({ success?: boolean; bisUnix?: number } & FehlerJson) | null;
      if (!vRes.ok || !vJson?.success || typeof vJson.bisUnix !== "number") {
        fehlerAnzeigen(vRes.status, vJson);
        return;
      }
      bestaetigtSetzen(vJson.bisUnix);
    } catch {
      toast.error("Bestätigung fehlgeschlagen", { id: "stepup" });
    } finally {
      setPasskeyLaeuft(false);
    }
  }

  async function mitPasswort() {
    if (passkeyLaeuft || passwortLaeuft || !passwort) return;
    setPasswortLaeuft(true);
    try {
      const res = await fetch("/api/finanzen/stepup/passwort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passwort }),
      });
      const json = (await res.json().catch(() => null)) as ({ success?: boolean; bisUnix?: number } & FehlerJson) | null;
      if (!res.ok || !json?.success || typeof json.bisUnix !== "number") {
        fehlerAnzeigen(res.status, json);
        return;
      }
      bestaetigtSetzen(json.bisUnix);
    } catch {
      toast.error("Bestätigung fehlgeschlagen", { id: "stepup" });
    } finally {
      setPasswortLaeuft(false);
    }
  }

  if (endzustand) {
    return (
      <Card>
        <CardContent className="p-6">
          <EmptyState icon={ShieldCheck} title="Nur Administratoren" description={endzustand} />
        </CardContent>
      </Card>
    );
  }

  if (status === null) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Prüfe Freigabe ...</div>;
  }

  if (status.bestaetigt) {
    return <>{children}</>;
  }

  if (status.grund === "impersonation") {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            <h2 className="font-semibold">Finanzen gesperrt</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Finanzen sind im «Ansicht als»-Modus gesperrt. Entwickler-Modus beenden.
          </p>
        </CardContent>
      </Card>
    );
  }

  const beschaeftigt = passkeyLaeuft || passwortLaeuft;
  const passkeyMoeglich = status.passkeys > 0 && webauthn;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            <h2 className="font-semibold">Finanzen freischalten</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Zusätzlich zum vertrauten Gerät bestätigst du dich kurz — gilt 15 Minuten.
          </p>

          {passkeyMoeglich && (
            <div>
              <button
                type="button"
                onClick={() => { void mitPasskey(); }}
                disabled={beschaeftigt}
                className="kasten kasten-blue"
              >
                {passkeyLaeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5" />}
                {passkeyLaeuft ? "Wird bestätigt …" : "Mit Passkey bestätigen"}
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1 w-full max-w-xs">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="stepup-passwort">Passwort</label>
              <Input
                id="stepup-passwort"
                type="password"
                autoComplete="current-password"
                maxLength={STEPUP_PASSWORT_MAX}
                value={passwort}
                onChange={(e) => setPasswort(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void mitPasswort();
                  }
                }}
                disabled={beschaeftigt}
              />
            </div>
            <button
              type="button"
              onClick={() => { void mitPasswort(); }}
              disabled={beschaeftigt || !passwort}
              className="kasten kasten-muted"
            >
              {passwortLaeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
              {passwortLaeuft ? "Wird bestätigt …" : "Mit Passwort bestätigen"}
            </button>
          </div>

          {gesperrtText && (
            <p className="text-xs text-red-600 dark:text-red-400">{gesperrtText}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
