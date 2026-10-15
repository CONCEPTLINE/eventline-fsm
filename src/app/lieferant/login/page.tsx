"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { Info, ArrowLeft, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/app-url";
import { PORTALS, portalForRole } from "@/lib/portals";

// Lieferanten-Login — Spiegel von /partner/login. Nach dem Login landet der
// Lieferant auf seinem Arbeitsort (PORTALS.lieferant.homePath = Anfragen).
// Authentifizierung-Logik teilt sich mit /login, aber:
//  - Nach erfolg: Profil-Rolle pruefen. Nur 'lieferant' darf bleiben. Andere
//    Rollen werden mit Hinweis abgewiesen (sie sollen ueber /login bzw.
//    /partner/login rein).
//  - Passwort-Reset analog zu /login. Der Reset-Link fuehrt auf
//    /passwort-reset.

/** Leiser Text-Knopf: grau, beim Hover Vordergrundfarbe (state-driven, §3). */
function LeiserKnopf({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="w-full text-xs transition-colors"
      style={{ color: hover ? "var(--foreground)" : "var(--muted-foreground)" }}
    >
      {children}
    </button>
  );
}

/** Datenschutz-Link unten — gleiche leise Optik wie LeiserKnopf. */
function DatenschutzLink() {
  const [hover, setHover] = useState(false);
  return (
    <PrefetchLink
      href="/datenschutz"
      onMouseOver={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="transition-colors"
      style={{ color: hover ? "var(--foreground)" : undefined }}
    >
      Datenschutz
    </PrefetchLink>
  );
}

export default function LieferantLoginPage() {
  const searchParams = useSearchParams();
  // Email aus URL-Prefill (kommt von /login wenn der Lieferant faelschlich
  // dort gestartet hat) — spart das erneute Eintippen.
  const [email, setEmail] = useState(() => searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const reason = searchParams.get("reason");
  const fromWrongPortal = reason === "wrong_portal";
  // Banner-Text je reason — deactivated/nofirma kommen aus dem Portal-Layout
  // (Guard hat den User rausgeworfen), wrong_portal von /login bzw.
  // /partner/login.
  const reasonBanner =
    reason === "wrong_portal" ? (
      <>
        <strong className="font-semibold">Als Lieferant musst du hier rein.</strong>{" "}
        Bitte Passwort eingeben.
      </>
    ) : reason === "deactivated" ? (
      <>
        <strong className="font-semibold">Dein Zugang ist im Moment nicht aktiv.</strong>{" "}
        Wende dich an EVENTLINE.
      </>
    ) : reason === "nofirma" ? (
      <>
        Deinem Zugang ist noch keine Lieferanten-Firma zugeordnet — bitte bei
        EVENTLINE melden.
      </>
    ) : null;

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    // Pre-flight: EVENTLINE-Mitarbeiter und Location-Partner duerfen sich
    // nicht ueber das Lieferanten-Login anmelden. Wenn die Email zu einem
    // internen User bzw. Partner gehoert, direkt aufs richtige Portal
    // weiterleiten (mit Email-Prefill), bevor ueberhaupt ein Auth-Versuch
    // passiert. Spiegel-Logik zu /login → /partner/login → /lieferant/login.
    // try/catch damit ein Netzfehler auf dem Pre-Flight-RPC den Login-
    // Button nicht in "Anmelden…" stecken laesst — bei RPC-Fehler
    // ignorieren wir den Pre-Check und lassen den normalen Auth-Flow
    // laufen (der Backstop weiter unten faengt den Fall trotzdem ab).
    try {
      const { data: isEventline, error: rpcErr } = await supabase.rpc("is_eventline_email", { p_email: email });
      if (!rpcErr && isEventline === true) {
        router.push(`/login?email=${encodeURIComponent(email)}&reason=wrong_portal`);
        return;
      }
      const { data: isPartner, error: rpcErr2 } = await supabase.rpc("is_partner_email", { p_email: email });
      if (!rpcErr2 && isPartner === true) {
        router.push(`/partner/login?email=${encodeURIComponent(email)}&reason=wrong_portal`);
        return;
      }
    } catch {
      // Silent — Backstop nach signInWithPassword faengt Fremd-Rollen auch dann ab.
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      // Supabase liefert bei gebannten/deaktivierten Usern oft "Invalid login
      // credentials" — selbe Meldung wie bei falschem Passwort. Bei expliziten
      // ban-Codes geben wir die spezifische Meldung.
      const msg = (error.message ?? "").toLowerCase();
      const code = (error as { code?: string }).code;
      if (msg.includes("banned") || msg.includes("deactivated") || code === "user_banned") {
        setError("Dein Zugang ist im Moment nicht aktiv. Wende dich an EVENTLINE.");
      } else {
        setError("E-Mail oder Passwort ist falsch.");
      }
      setLoading(false);
      return;
    }

    if (data.user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, is_active")
        .eq("id", data.user.id)
        .maybeSingle();
      if (!profile || profile.is_active === false) {
        // Bewusst global: ein gesperrtes Konto fliegt auf ALLEN Geraeten raus.
        await supabase.auth.signOut({ scope: "global" });
        setError("Dein Benutzer hat im Moment keinen Zugriff. Wende dich an EVENTLINE.");
        setLoading(false);
        return;
      }
      // Sicherheits-Backstop falls die pre-flight-Email-Pruefung
      // umgangen wurde (race, anderer email-Case): sofort signOut +
      // Redirect auf das richtige Portal. Andere Portal-Rollen (z.B.
      // Partner) gehen via Registry direkt auf IHR Portal-Login,
      // interne User auf /login. Nur die eben hier erzeugte Sitzung beenden —
      // die Sitzungen auf den anderen Geraeten des Nutzers bleiben.
      if (profile.role !== "lieferant") {
        await supabase.auth.signOut({ scope: "local" });
        const other = portalForRole(profile.role);
        router.push(`${other?.loginPath ?? "/login"}?email=${encodeURIComponent(email)}&reason=wrong_portal`);
        return;
      }
    }

    router.push(PORTALS.lieferant.homePath);
    router.refresh();
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

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
          <div className="flex justify-center items-start gap-3 mb-6">
            <Logo size="lg" />
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-muted-foreground mt-1">
              Lieferant
            </p>
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Lieferantenportal
          </p>
        </CardHeader>
        <CardContent className="px-8 pb-10">
          {reasonBanner && !resetMode && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2.5 text-xs">
              <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="text-amber-800 dark:text-amber-200">{reasonBanner}</div>
            </div>
          )}
          {resetMode ? (
            resetSent ? (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-500/20 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-7 h-7 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                </div>
                <h3 className="font-semibold text-lg">E-Mail gesendet!</h3>
                <p className="text-sm text-muted-foreground mt-2">
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
                    placeholder="lieferant@firma.ch"
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
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Wird gesendet…
                    </>
                  ) : (
                    "Link senden"
                  )}
                </button>
                <LeiserKnopf onClick={() => { setResetMode(false); setError(""); }}>
                  Zurück zum Login
                </LeiserKnopf>
              </form>
            )
          ) : (
            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">E-Mail</Label>
                <Input id="email" type="email" placeholder="lieferant@firma.ch" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus={!fromWrongPortal} className="h-10" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">Passwort</Label>
                <Input id="password" type="password" placeholder="Passwort eingeben" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" autoFocus={fromWrongPortal} className="h-10" />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button type="submit" className="kasten kasten-red w-full !py-2.5 !text-sm" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Wird angemeldet…
                  </>
                ) : (
                  "Anmelden"
                )}
              </button>
              <LeiserKnopf onClick={() => { setResetMode(true); setError(""); }}>
                Passwort vergessen?
              </LeiserKnopf>
            </form>
          )}
        </CardContent>
      </Card>
      <div className="absolute bottom-4 left-0 right-0 text-center text-[11px] text-muted-foreground">
        <DatenschutzLink />
      </div>
    </div>
  );
}
