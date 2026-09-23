"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { portalForRole } from "@/lib/portals";

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
            const msg = "Reset-Link ungültig oder abgelaufen. Bitte neuen Link anfordern.";
            setError(msg);
            toast.error(msg);
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
      const msg = "Passwort konnte nicht geändert werden: " + error.message;
      setError(msg);
      toast.error(msg);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
    // Rolle pruefen — Portal-User (Partner/Lieferant/…) gehen auf die
    // Startseite ihres Portals (Registry), sonst Dashboard.
    const { data: { user } } = await supabase.auth.getUser();
    let target = "/dashboard";
    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      const portal = portalForRole(profile?.role);
      if (portal) target = portal.homePath;
    }
    setTimeout(() => router.push(target), 2000);
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-background via-background to-foreground/[0.04]">
      <Card className="w-full max-w-md border-foreground/10 shadow-xl">
        <CardHeader className="text-center pb-2">
          <div className="mb-4 flex justify-center">
            <Logo size="lg" />
          </div>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="text-center py-4">
              <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-500/15 flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <h3 className="font-semibold text-lg">Passwort geändert!</h3>
              <p className="text-sm text-muted-foreground mt-2">Du wirst zum Dashboard weitergeleitet...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="text-center mb-2">
                <h3 className="font-semibold">Neues Passwort setzen</h3>
                <p className="text-sm text-muted-foreground mt-1">Gib dein neues Passwort ein</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">Neues Passwort</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Min. 6 Zeichen"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm" className="text-xs font-medium text-muted-foreground">Passwort bestätigen</Label>
                <Input
                  id="confirm"
                  type="password"
                  placeholder="Passwort wiederholen"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  className="h-10"
                />
              </div>
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <button
                type="submit"
                className="kasten kasten-red w-full !py-2.5 !text-sm"
                disabled={loading || !sessionReady}
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? "Wird gespeichert…" : !sessionReady ? "Lade…" : "Passwort ändern"}
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
