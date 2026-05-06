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

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError("E-Mail oder Passwort ist falsch.");
      setLoading(false);
      return;
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
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-md border shadow-2xl">
        <CardHeader className="text-center pb-2">
          <div className="mb-4 flex justify-center">
            <Logo size="lg" />
          </div>
          <p className="text-sm text-gray-500">
            Field Service Management
          </p>
        </CardHeader>
        <CardContent>
          {wasInactive && !resetMode && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2.5 text-xs">
              <Clock className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="text-amber-800 dark:text-amber-200">
                <strong className="font-semibold">Wegen Inaktivität ausgeloggt.</strong>{" "}
                Bitte erneut anmelden um weiterzumachen.
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
              <form onSubmit={handleReset} className="space-y-4">
                <div className="text-center mb-2">
                  <h3 className="font-semibold">Passwort zurücksetzen</h3>
                  <p className="text-sm text-gray-500 mt-1">Gib deine E-Mail-Adresse ein</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="resetEmail">E-Mail</Label>
                  <Input
                    id="resetEmail"
                    type="email"
                    placeholder="name@eventline-basel.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
                <Button
                  type="submit"
                  className="w-full bg-red-600 hover:bg-red-700 text-white"
                  disabled={loading}
                >
                  {loading ? "Senden..." : "Link senden"}
                </Button>
                <button
                  type="button"
                  onClick={() => { setResetMode(false); setError(""); }}
                  className="w-full text-sm text-gray-500 hover:text-gray-700 mt-2"
                >
                  Zurück zum Login
                </button>
              </form>
            )
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">E-Mail</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="name@eventline-basel.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Passwort</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Passwort eingeben"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}
              <Button
                type="submit"
                className="w-full bg-red-600 hover:bg-red-700 text-white"
                disabled={loading}
              >
                {loading ? "Anmelden..." : "Anmelden"}
              </Button>
              <button
                type="button"
                onClick={() => { setResetMode(true); setError(""); }}
                className="w-full text-sm text-gray-500 hover:text-gray-700"
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
