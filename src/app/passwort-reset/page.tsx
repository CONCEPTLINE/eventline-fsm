"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { ArrowLeft, Link2Off, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { portalForRole } from "@/lib/portals";

const LINK_INVALID_MSG = "Dieser Link ist abgelaufen oder ungültig. Fordere einen neuen an.";
// Obergrenze fuer die Link-Pruefung (Session aus Link setzen / Code tauschen).
const CHECK_TIMEOUT_MS = 15_000;

export default function PasswortResetPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // Zustand des Reset-Links: erst pruefen, dann entweder Formular frei-
  // geben oder klar sagen, dass der Link nicht (mehr) gilt. Frueher gab es
  // nur "bereit ja/nein" — ein ungueltiger Link blieb dadurch fuer immer
  // auf «Lade…» stehen, ohne Weg zurueck.
  const [linkStatus, setLinkStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const router = useRouter();
  const supabase = createClient();

  // Recovery-Link auswerten. Drei Formen kommen hier an:
  //  1. Implicit (admin generate_link, Einladung/Reset durch Admin):
  //       #access_token=...&refresh_token=...&type=recovery
  //     Der @supabase/ssr-Browser-Client ist auf PKCE eingestellt und
  //     uebernimmt den Hash nicht — wir setzen die Session explizit und
  //     raeumen danach den Hash (kein Token-Leak in History/Referer).
  //  2. PKCE (resetPasswordForEmail von den Login-Seiten): ?code=...
  //     Den Austausch macht der Client selbst beim Start; getSession()
  //     wartet darauf und entfernt ?code bei Erfolg aus der URL.
  //  3. Fehler-Redirect von Supabase bei abgelaufenem/benutztem Link:
  //       #error=access_denied&error_code=otp_expired&error_description=...
  //     (bei PKCE in der Query). Dann gilt der Link NIE — auch wenn im
  //     Browser zufaellig noch jemand angemeldet ist.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const hashParams = new URLSearchParams(hash);
    const queryParams = new URLSearchParams(window.location.search);
    const urlHasError = ["error", "error_code", "error_description"].some(
      (k) => hashParams.has(k) || queryParams.has(k),
    );
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");

    let settled = false;
    let toasted = false;

    function markInvalid() {
      if (cancelled) return;
      settled = true;
      setLinkStatus("invalid");
      if (!toasted) {
        toasted = true;
        toast.error(LINK_INVALID_MSG);
      }
    }

    function markReady() {
      if (cancelled) return;
      settled = true;
      setLinkStatus("ready");
      // Token/Code aus der URL entfernen — kein Leak in History/Referer.
      window.history.replaceState(null, "", window.location.pathname);
    }

    // Sicherheitsnetz: haengt die Pruefung (z.B. Netz weg), nicht ewig
    // «wird geprüft» zeigen. Ein spaeter doch noch eintreffendes Ergebnis
    // ueberschreibt den Zustand regulaer.
    const timeout = window.setTimeout(() => {
      if (!settled) markInvalid();
    }, CHECK_TIMEOUT_MS);

    (async () => {
      try {
        if (urlHasError) {
          markInvalid();
          return;
        }

        if (accessToken && refreshToken) {
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (error) markInvalid();
          else markReady();
          return;
        }

        const { data } = await supabase.auth.getSession();
        // Steht ?code nach dem Start des Clients noch in der URL, ist der
        // Austausch gescheitert (ungueltiger/benutzter Code oder Link in
        // einem anderen Browser geoeffnet). Eine evtl. vorhandene alte
        // Session gehoert dann nicht zu diesem Link.
        const codeStillInUrl = new URLSearchParams(window.location.search).has("code");
        if (data.session && !codeStillInUrl) markReady();
        else markInvalid();
      } catch {
        markInvalid();
      } finally {
        window.clearTimeout(timeout);
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
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
          ) : linkStatus === "invalid" ? (
            <div className="text-center py-4">
              <div className="w-14 h-14 rounded-full bg-red-100 dark:bg-red-500/15 flex items-center justify-center mx-auto mb-4">
                <Link2Off className="w-6 h-6 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="font-semibold text-lg">Link nicht mehr gültig</h3>
              <p className="text-sm text-muted-foreground mt-2">{LINK_INVALID_MSG}</p>
              {/* /login?reset=1 startet direkt im «Passwort vergessen?»-Modus. */}
              <Link
                href="/login?reset=1"
                className="mt-6 inline-flex min-h-[44px] items-center justify-center gap-1.5 text-sm font-medium text-foreground underline underline-offset-4"
              >
                <ArrowLeft className="h-4 w-4" />
                Neuen Link anfordern
              </Link>
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
                disabled={loading || linkStatus !== "ready"}
              >
                {(loading || linkStatus === "checking") && <Loader2 className="h-4 w-4 animate-spin" />}
                {loading ? "Wird gespeichert…" : linkStatus === "checking" ? "Link wird geprüft…" : "Passwort ändern"}
              </button>
            </form>
          )}
        </CardContent>
      </Card>
      <div className="absolute bottom-4 left-0 right-0 text-center text-[11px] text-muted-foreground">
        <Link href="/datenschutz" className="hover:text-foreground transition-colors">Datenschutz</Link>
      </div>
      {/* Seite liegt ausserhalb der App-/Portal-Layouts — ohne eigenen
          Toaster wuerden die toast.error()-Aufrufe hier ins Leere gehen. */}
      <Toaster />
    </div>
  );
}
