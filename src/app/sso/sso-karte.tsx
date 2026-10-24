"use client";

import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Logo } from "@/components/logo";

/** sessionStorage: pending_id (von POST /api/auth/trust-one) + Trust-one-Name zur Anzeige. */
export const TRUST_ONE_PENDING_KEY = "trust-one-pending";
export const TRUST_ONE_NAME_KEY = "trust-one-pending-name";
/** Startseite der App nach dem Login (wie /login). */
export const APP_START = "/dashboard";
export const VERBINDEN_PFAD = "/sso/verbinden";

export function pendingVergessen() {
  try {
    sessionStorage.removeItem(TRUST_ONE_PENDING_KEY);
    sessionStorage.removeItem(TRUST_ONE_NAME_KEY);
  } catch {
    /* Storage blockiert — nichts zu raeumen */
  }
}

/** Rahmen der Trust-one-Seiten (/sso, /sso/verbinden) — gleiche Karte wie /login. */
export function SsoKarte({ children }: { children: React.ReactNode }) {
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
        <CardContent className="px-8 pb-10 page-enter">{children}</CardContent>
      </Card>
    </div>
  );
}

/** Lade-Zustand: Spinner + kurzer Text, mittig. */
export function SsoLaden({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground" role="status" aria-live="polite">
      <Loader2 className="h-6 w-6 animate-spin text-foreground/60" />
      {text}
    </div>
  );
}
