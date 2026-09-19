"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { ArrowLeft, Clock, Info, Fingerprint, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/app-url";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";

// Deactivated-Message stand vorher zweimal wortgleich im File — Konstante
// hier oben statt beim naechsten Copy-Edit auseinanderdriften.
const MSG_USER_DEACTIVATED = "Dein Benutzer hat im Moment keinen Zugriff. Wende dich an einen Admin.";

export default function LoginPage() {
  const searchParams = useSearchParams();
  // Email-Prefill kommt von /partner/login wenn ein EVENTLINE-Mitarbeiter
  // faelschlich dort gestartet hat — Spiegel zu /login→/partner/login.
  const [email, setEmail] = useState(() => searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    // Nur wenn der Browser WebAuthn kann — sonst Button gar nicht erst zeigen.
    setPasskeySupported(browserSupportsWebAuthn());
  }, []);
  // ?reason=inactive — Login-Page wurde nach Inaktivitaets-Logout angesteuert.
  // Hinweis fuer den User damit er weiss warum er ausgeloggt wurde.
  const reason = searchParams.get("reason");
  const wasInactive = reason === "inactive";
  const wasDeactivated = reason === "deactivated";
  const fromWrongPortal = reason === "wrong_portal";

  // Auto-Trigger: beim Oeffnen der Login-Seite direkt Face-ID/Passkey
  // aufpoppen lassen (aggressive UX, sinnvoll fuer Mobile/PWA). Guards:
  // - SSR (typeof window)
  // - Kein Redirect-Grund gesetzt (?reason=…) — sonst wurde User gerade
  //   ausgeloggt / vom Partner-Portal geschubst und der Auto-Prompt
  //   waere doppelt-nervig.
  // - Kein ?email=-Prefill — kam ebenfalls per Redirect (Partner-Spiegel).
  // - Nicht im Reset-Mode (User will Passwort zuruecksetzen).
  // - Browser kann WebAuthn UND conditional-mediation. Letzteres ist
  //   der Indikator dass der Browser Passkeys ernst nimmt — sonst kann
  //   nativer .get() sofort abstuerzen.
  // - Anti-Loop: sessionStorage-Flag `passkey-auto-attempted`. Wenn der
  //   Auto-Prompt einmal in dieser Session gefeuert wurde, nicht nochmal
  //   — sonst geraet ein User, der einmal abgebrochen hat, in eine
  //   Endlosschleife bei jedem Rerender/Reload.
  // - Fehler werden im silent-Mode geschluckt (siehe handlePasskeyLogin) —
  //   Passwort-Form bleibt sichtbar, kein Toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (reason) return;
    if (searchParams.get("email")) return;
    if (resetMode) return;

    let active = true;
    (async () => {
      try {
        if (typeof PublicKeyCredential === "undefined") return;
        if (!browserSupportsWebAuthn()) return;
        const condAvail = await PublicKeyCredential.isConditionalMediationAvailable?.();
        if (!condAvail) return;
        if (sessionStorage.getItem("passkey-auto-attempted") === "1") return;
        // Flag VOR dem Trigger setzen — auch StrictMode-Double-Mount in
        // dev feuert dann nur einmal, und ein Cancel-Klick fuehrt nicht
        // zu einem zweiten Prompt bei Rerender.
        sessionStorage.setItem("passkey-auto-attempted", "1");
        if (!active) return;
        await handlePasskeyLogin({ silent: true });
      } catch {
        // Stille aufraeumen — User hat den Prompt nicht angefordert.
      }
    })();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    // Pre-flight: Partner-User duerfen sich nicht ueber das Firmenportal-
    // Login anmelden. Wenn die Email einem Partner gehoert, leiten wir
    // direkt zur Partner-Login-Seite weiter (mit Email-Prefill), bevor
    // ueberhaupt ein Auth-Versuch passiert. So braucht's kein signOut-Dance
    // und Partner haben einen klaren UX-Hint dass sie das falsche Portal
    // verwendet haben.
    //
    // try/catch damit ein Netzfehler auf dem Pre-Flight-RPC den Login-
    // Button nicht in "Anmelden…" stecken laesst — bei RPC-Fehler
    // ignorieren wir den Pre-Check und lassen den normalen Auth-Flow
    // laufen (der Backstop weiter unten faengt den Fall trotzdem ab).
    try {
      const { data: isPartner, error: rpcErr } = await supabase.rpc("is_partner_email", { p_email: email });
      if (!rpcErr && isPartner === true) {
        router.push(`/partner/login?email=${encodeURIComponent(email)}&reason=wrong_portal`);
        return;
      }
      const { data: isLieferant, error: rpcErr2 } = await supabase.rpc("is_lieferant_email", { p_email: email });
      if (!rpcErr2 && isLieferant === true) {
        router.push(`/lieferant/login?email=${encodeURIComponent(email)}&reason=wrong_portal`);
        return;
      }
    } catch {
      // Silent — Backstop nach signInWithPassword faengt Portal-Rollen auch dann ab.
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      // Supabase liefert bei gebannten/deaktivierten Usern oft "Invalid login
      // credentials" — selbe Meldung wie bei falschem Passwort. Wir koennen
      // das nicht zuverlaessig unterscheiden ohne Email-Enumeration-Vector,
      // aber bei expliziten ban-Codes geben wir die spezifische Meldung.
      const msg = (error.message ?? "").toLowerCase();
      const code = (error as { code?: string }).code;
      if (msg.includes("banned") || msg.includes("deactivated") || code === "user_banned") {
        setError(MSG_USER_DEACTIVATED);
      } else {
        setError("E-Mail oder Passwort ist falsch.");
      }
      setLoading(false);
      return;
    }

    // Login durch — aber pruefe ob das profile aktiv ist. Wenn nicht: sofort
    // ausloggen + Hinweis. Schuetzt gegen den Edge-Case wo der Auth-Ban noch
    // nicht propagiert ist oder is_active ohne ban gesetzt wurde.
    if (data.user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, is_active")
        .eq("id", data.user.id)
        .maybeSingle();
      if (profile && profile.is_active === false) {
        await supabase.auth.signOut();
        setError(MSG_USER_DEACTIVATED);
        setLoading(false);
        return;
      }
      // Sicherheits-Backstop falls die pre-flight-Email-Pruefung
      // umgangen wurde (race condition, anderer email-Case etc.):
      // sofort signOut + Redirect auf Partner-Login.
      if (profile && profile.role === "partner") {
        await supabase.auth.signOut();
        router.push(`/partner/login?email=${encodeURIComponent(email)}&reason=wrong_portal`);
        return;
      }
      if (profile && profile.role === "lieferant") {
        await supabase.auth.signOut();
        router.push(`/lieferant/login?email=${encodeURIComponent(email)}&reason=wrong_portal`);
        return;
      }
    }

    router.push("/dashboard");
    router.refresh();
  }

  async function handlePasskeyLogin(opts?: { silent?: boolean }) {
    // `silent` = auto-getriggert beim Mount. Fehler werden geschluckt —
    // Passwort-Form bleibt sichtbar, kein setError-Rauschen, weil der
    // User den Prompt nicht explizit angefordert hat.
    const silent = opts?.silent === true;
    if (!silent) setError("");
    setPasskeyLoading(true);
    try {
      // Optional Email vom Feld nehmen — engt die Passkey-Auswahl im
      // Browser-Dialog ein. Ohne Email zeigt der Browser ALLE für die
      // Domain registrierten Passkeys (discoverable-flow).
      const chRes = await fetch("/api/auth/passkey/auth-challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() || undefined }),
      });
      const chJson = await chRes.json();
      if (!chRes.ok || !chJson.success) {
        if (!silent) setError(chJson.error ?? "Passkey-Login konnte nicht gestartet werden.");
        return;
      }

      let authResp;
      try {
        authResp = await startAuthentication({ optionsJSON: chJson.options });
      } catch (e) {
        // Abbruch durch User oder kein passender Passkey am Gerät.
        const msg = e instanceof Error ? e.message : "Abgebrochen";
        if (/cancel|abort/i.test(msg)) return;
        if (!silent) setError(msg);
        return;
      }

      const verifyRes = await fetch("/api/auth/passkey/auth-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: authResp }),
      });
      const verifyJson = await verifyRes.json();
      if (!verifyRes.ok || !verifyJson.success) {
        if (!silent) setError(verifyJson.error ?? "Passkey-Verifikation fehlgeschlagen.");
        return;
      }

      // Session erzeugen via magic-link-Token, das der Server nach dem
      // erfolgreichen Passkey-Verify ausliefert (siehe auth-verify/route.ts).
      const { error: otpErr } = await supabase.auth.verifyOtp({
        type: "email",
        token_hash: verifyJson.token_hash as string,
      });
      if (otpErr) {
        if (!silent) setError("Session-Erzeugung fehlgeschlagen: " + otpErr.message);
        return;
      }

      // Partner-Backstop: analog zum Passwort-Flow. Wenn ein Partner-
      // Account sich hier eingeloggt hat → wieder aus + Redirect.
      if (verifyJson.role === "partner") {
        const partnerEmail = (verifyJson.email as string) ?? email;
        await supabase.auth.signOut();
        router.push(`/partner/login?email=${encodeURIComponent(partnerEmail)}&reason=wrong_portal`);
        return;
      }
      if (verifyJson.role === "lieferant") {
        const lieferantEmail = (verifyJson.email as string) ?? email;
        await supabase.auth.signOut();
        router.push(`/lieferant/login?email=${encodeURIComponent(lieferantEmail)}&reason=wrong_portal`);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    // Stable redirect: NIE window.location.origin nehmen — sonst landet
    // der Reset-Link auf der per-deployment URL aus der der User gerade
    // kommt (z.B. eventline-fsm-usyk-h69yfgtq1...) und der User bleibt
    // dann auf einem eingefrorenen alten Build haengen. appUrl() loest
    // ueber NEXT_PUBLIC_APP_URL stabil auf die Production-Domain auf.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: appUrl("/passwort-reset"),
    });

    if (error) {
      setError("Fehler: " + error.message);
      setLoading(false);
      return;
    }

    setResetSent(true);
    setLoading(false);
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-background via-background to-foreground/[0.04]">
      <Card className="w-full max-w-md border-foreground/10 shadow-xl">
        <CardHeader className="text-center pb-4 pt-12">
          <div className="flex justify-center mb-6">
            <Logo size="lg" />
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Field Service Management
          </p>
        </CardHeader>
        <CardContent className="px-8 pb-10">
          {wasInactive && !resetMode && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2.5 text-xs">
              <Clock className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="text-amber-800 dark:text-amber-200">
                <strong className="font-semibold">Wegen Inaktivität ausgeloggt.</strong>{" "}
                Bitte erneut anmelden um weiterzumachen.
              </div>
            </div>
          )}
          {wasDeactivated && !resetMode && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 dark:bg-red-500/10 dark:border-red-500/30 px-3 py-2.5 text-xs">
              <Clock className="h-4 w-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
              <div className="text-red-800 dark:text-red-200">
                <strong className="font-semibold">Dein Benutzer hat im Moment keinen Zugriff.</strong>{" "}
                Wende dich an einen Admin.
              </div>
            </div>
          )}
          {fromWrongPortal && !resetMode && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2.5 text-xs">
              <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="text-amber-800 dark:text-amber-200">
                <strong className="font-semibold">Als EVENTLINE-Mitarbeiter musst du hier rein.</strong>{" "}
                Bitte Passwort eingeben.
              </div>
            </div>
          )}
          {resetMode ? (
            resetSent ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                </div>
                <h3 className="font-semibold text-lg">E-Mail gesendet!</h3>
                <p className="text-sm text-gray-500 mt-2">
                  Prüfe dein Postfach bei <strong>{email}</strong>. Klicke auf den Link in der E-Mail um dein Passwort zurückzusetzen.
                </p>
                <button
                  type="button"
                  onClick={() => { setResetMode(false); setResetSent(false); }}
                  className="kasten kasten-muted mt-6"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Zurück zum Login
                </button>
              </div>
            ) : (
              <form onSubmit={handleReset} className="space-y-5">
                <div className="text-center mb-2">
                  <h3 className="font-semibold">Passwort zurücksetzen</h3>
                  <p className="text-sm text-muted-foreground mt-1">Gib deine E-Mail-Adresse ein</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="resetEmail" className="text-xs font-medium text-muted-foreground">E-Mail</Label>
                  <Input
                    id="resetEmail"
                    type="email"
                    placeholder="name@eventline-basel.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="username"
                    className="h-10"
                  />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <button
                  type="submit"
                  className="kasten kasten-red w-full !py-2.5 !text-sm"
                  disabled={loading}
                >
                  {loading ? "Senden..." : "Link senden"}
                </button>
                <button
                  type="button"
                  onClick={() => { setResetMode(false); setError(""); }}
                  className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Zurück zum Login
                </button>
              </form>
            )
          ) : (
            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">E-Mail</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="name@eventline-basel.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus={!fromWrongPortal}
                  autoComplete="username webauthn"
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">Passwort</Label>
                <Input
                  id="password"
                  type="password"
                  autoFocus={fromWrongPortal}
                  placeholder="Passwort eingeben"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="h-10"
                />
              </div>
              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}
              <button
                type="submit"
                className="kasten kasten-red w-full !py-2.5 !text-sm"
                disabled={loading || passkeyLoading}
              >
                {loading ? "Anmelden..." : "Anmelden"}
              </button>

              {passkeySupported && (
                <>
                  {/* Trenner + Passkey-Button. Nur wenn der Browser
                      WebAuthn kann — sonst verwirrend fuer User die keinen
                      Passkey einrichten koennen. */}
                  <div className="flex items-center gap-3 py-0.5">
                    <div className="h-px flex-1 bg-foreground/10" />
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">oder</span>
                    <div className="h-px flex-1 bg-foreground/10" />
                  </div>
                  <button
                    type="button"
                    onClick={() => handlePasskeyLogin()}
                    disabled={loading || passkeyLoading}
                    className="kasten kasten-muted w-full !py-2.5 !text-sm"
                  >
                    {passkeyLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Fingerprint className="h-4 w-4" />
                    )}
                    {passkeyLoading ? "Wird geprüft…" : "Mit Passkey einloggen"}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => { setResetMode(true); setError(""); }}
                className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Passwort vergessen?
              </button>
            </form>
          )}
        </CardContent>
      </Card>
      <div className="absolute bottom-4 left-0 right-0 text-center text-[11px] text-muted-foreground">
        <Link href="/datenschutz" className="hover:text-foreground transition-colors">Datenschutz</Link>
      </div>
    </div>
  );
}
