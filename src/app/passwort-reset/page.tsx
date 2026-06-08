"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";

export default function PasswortResetPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  // Recovery-Token aus dem URL-Hash uebernehmen.
  //
  // Supabase's admin-generate_link liefert Recovery-URLs im "implicit
  // flow"-Format: nach dem Verify-Hop steht im Hash
  //   #access_token=...&refresh_token=...&type=recovery
  // Der @supabase/ssr-Browser-Client ist aber per Default fuer PKCE
  // konfiguriert und greift den Hash nicht zuverlaessig auf — daher
  // setzen wir die Session hier explizit. Danach Hash aus der URL
  // raeumen damit der Token nicht in History/Referer leakt.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");

    if (accessToken && refreshToken) {
      supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        .then(({ error }) => {
          if (error) {
            setError("Reset-Link ungültig oder abgelaufen. Bitte neuen Link anfordern.");
          } else {
            setSessionReady(true);
            // Hash aus der URL entfernen — kein Token-Leak in History
            window.history.replaceState(null, "", window.location.pathname);
          }
        });
      return;
    }

    // Kein Hash → vielleicht hat die Session schon (z.B. Reload nach Fix)
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setSessionReady(true);
      else setError("Kein gültiger Reset-Link. Bitte den Link aus deiner Mail erneut öffnen.");
    });
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 6) {
      setError("Passwort muss mindestens 6 Zeichen lang sein.");
      return;
    }

    if (password !== confirm) {
      setError("Passwörter stimmen nicht überein.");
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError("Fehler: " + error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
    // Rolle pruefen — Partner gehen nach /partner/anfragen, sonst Dashboard.
    const { data: { user } } = await supabase.auth.getUser();
    let target = "/dashboard";
    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.role === "partner") target = "/partner/anfragen";
    }
    setTimeout(() => router.push(target), 2000);
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <Card className="w-full max-w-md border shadow-2xl">
        <CardHeader className="text-center pb-2">
          <div className="mb-4 flex justify-center">
            <Logo size="lg" />
          </div>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="text-center py-4">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <h3 className="font-semibold text-lg">Passwort geändert!</h3>
              <p className="text-sm text-gray-500 mt-2">Du wirst zum Dashboard weitergeleitet...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="text-center mb-2">
                <h3 className="font-semibold">Neues Passwort setzen</h3>
                <p className="text-sm text-gray-500 mt-1">Gib dein neues Passwort ein</p>
              </div>
              <div className="space-y-2">
                <Label>Neues Passwort</Label>
                <Input
                  type="password"
                  placeholder="Min. 6 Zeichen"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Passwort bestätigen</Label>
                <Input
                  type="password"
                  placeholder="Passwort wiederholen"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button
                type="submit"
                className="w-full bg-red-600 hover:bg-red-700 text-white"
                disabled={loading || !sessionReady}
              >
                {loading ? "Speichern…" : !sessionReady ? "Lade…" : "Passwort ändern"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
