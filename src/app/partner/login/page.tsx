"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { Info } from "lucide-react";

// Partner-Login — eigene Seite, eigener Redirect-Pfad (/partner/anfragen).
// Authentifizierung-Logik teilt sich mit /login, aber:
//  - Nach erfolg: Profil-Rolle pruefen. Nur 'partner' darf bleiben. Andere
//    Rollen werden mit Hinweis abgewiesen (sie sollen ueber /login rein).
//  - Reset-Password-Flow ist hier nicht; Partner-Admin (Leo) loescht/legt
//    den Partner neu an wenn was schief geht.

export default function PartnerLoginPage() {
  const searchParams = useSearchParams();
  // Email aus URL-Prefill (kommt von /login wenn der Partner faelschlich
  // dort gestartet hat) — spart das erneute Eintippen.
  const [email, setEmail] = useState(() => searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const fromWrongPortal = searchParams.get("reason") === "wrong_portal";

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError("E-Mail oder Passwort ist falsch.");
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
        await supabase.auth.signOut();
        setError("Dein Benutzer hat im Moment keinen Zugriff. Wende dich an EVENTLINE.");
        setLoading(false);
        return;
      }
      if (profile.role !== "partner") {
        await supabase.auth.signOut();
        setError("Dieser Login ist nur für Location-Partner. EVENTLINE-Mitarbeiter bitte über die normale Login-Seite.");
        setLoading(false);
        return;
      }
    }

    router.push("/partner/anfragen");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-background via-background to-foreground/[0.04]">
      <Card className="w-full max-w-md border-foreground/10 shadow-xl overflow-hidden relative">
        {/* Roter Akzent-Streifen oben — visuelles "anders als Firmenportal"-Signal */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-red-600" />
        <CardHeader className="text-center pb-4 pt-10">
          <div className="flex justify-center items-start gap-4">
            <Logo size="xl" />
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-red-600 dark:text-red-400 mt-2">
              Partner
            </p>
          </div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground mt-4">
            Location-Portal
          </p>
        </CardHeader>
        <CardContent className="px-8 pb-10">
          {fromWrongPortal && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2.5 text-xs">
              <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="text-amber-800 dark:text-amber-200">
                <strong className="font-semibold">Als Location-Partner musst du hier rein.</strong>{" "}
                Bitte Passwort eingeben.
              </div>
            </div>
          )}
          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">E-Mail</Label>
              <Input id="email" type="email" placeholder="partner@firma.ch" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!fromWrongPortal} className="h-10" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">Passwort</Label>
              <Input id="password" type="password" placeholder="Passwort eingeben" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={fromWrongPortal} className="h-10" />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button type="submit" className="w-full h-11 bg-red-600 hover:bg-red-700 text-white font-semibold shadow-sm" disabled={loading}>
              {loading ? "Anmelden..." : "Anmelden"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
