"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { ArrowLeft, Clock } from "lucide-react";
import { appUrl } from "@/lib/app-url";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  // ?reason=inactive — Login-Page wurde nach Inaktivitaets-Logout angesteuert.
  // Hinweis fuer den User damit er weiss warum er ausgeloggt wurde.
  const reason = useSearchParams().get("reason");
  const wasInactive = reason === "inactive";
  const wasDeactivated = reason === "deactivated";

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
    const { data: isPartner } = await supabase.rpc("is_partner_email", { p_email: email });
    if (isPartner === true) {
      router.push(`/partner/login?email=${encodeURIComponent(email)}&reason=wrong_portal`);
      return;
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
        setError("Dein Benutzer hat im Moment keinen Zugriff. Wende dich an einen Admin.");
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
        setError("Dein Benutzer hat im Moment keinen Zugriff. Wende dich an einen Admin.");
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
    }

    router.push("/dashboard");
    router.refresh();
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
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-background via-background to-foreground/[0.04]">
      <Card className="w-full max-w-md border-foreground/10 shadow-xl">
        <CardHeader className="text-center pb-4 pt-10">
          <div className="flex justify-center">
            <Logo size="xl" />
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground mt-4">
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
                <Button
                  onClick={() => { setResetMode(false); setResetSent(false); }}
                  variant="outline"
                  className="mt-6"
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Zurück zum Login
                </Button>
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
                    className="h-10"
                  />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button
                  type="submit"
                  className="w-full h-11 bg-red-600 hover:bg-red-700 text-white font-semibold shadow-sm"
                  disabled={loading}
                >
                  {loading ? "Senden..." : "Link senden"}
                </Button>
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
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">Passwort</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Passwort eingeben"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-10"
                />
              </div>
              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}
              <Button
                type="submit"
                className="w-full h-11 bg-red-600 hover:bg-red-700 text-white font-semibold shadow-sm"
                disabled={loading}
              >
                {loading ? "Anmelden..." : "Anmelden"}
              </Button>
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
    </div>
  );
}
