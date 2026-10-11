"use client";

/**
 * Mein-Konto-Onboarding-Provider.
 *
 * Haelt den Status der zwei Onboarding-Flags (intro_dismissed +
 * first_visited) zentral, damit Modal und Sidebar-Badge dieselbe
 * Wahrheit nutzen.
 *
 * Geladen via SECURITY-DEFINER-RPC `get_my_mein_konto_onboarding` —
 * konsistent mit dem Wage-Consent-Pattern.
 *
 * Loaded erst nachdem das Profil bereit ist (verhindert Race wo der
 * Hook vor Authentication feuert und ein leeres Ergebnis cached).
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface OnboardingState {
  introDismissedAt: string | null;
  firstVisitedAt: string | null;
  ready: boolean;
}

interface OnboardingContextValue extends OnboardingState {
  dismissIntro: () => Promise<void>;
  markVisited: () => Promise<void>;
}

const Ctx = createContext<OnboardingContextValue | null>(null);

interface Row {
  intro_dismissed_at: string | null;
  first_visited_at: string | null;
}

export function MeinKontoOnboardingProvider({
  children,
  profileReady,
}: {
  children: React.ReactNode;
  /** True wenn das Profil geladen ist — verhindert RPC-Aufruf vor Auth. */
  profileReady: boolean;
}) {
  const supabase = createClient();
  const [state, setState] = useState<OnboardingState>({
    introDismissedAt: null,
    firstVisitedAt: null,
    ready: false,
  });

  useEffect(() => {
    if (!profileReady) return;
    let cancelled = false;
    (async () => {
      // Fehler/offline = Status unbekannt: ready bleibt false, damit weder
      // Intro noch Sidebar-Badge aufgehen. Vorher galt ein Fehler als «noch
      // nicht gesehen» — das Intro kam bei jedem Start ohne Netz. Der
      // naechste Start mit Netz laedt neu.
      let data: unknown;
      try {
        const res = await supabase.rpc("get_my_mein_konto_onboarding");
        if (res.error) return;
        data = res.data;
      } catch {
        return;
      }
      if (cancelled) return;
      const row = (Array.isArray(data) ? data[0] : null) as Row | null;
      setState({
        introDismissedAt: row?.intro_dismissed_at ?? null,
        firstVisitedAt: row?.first_visited_at ?? null,
        ready: true,
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileReady]);

  const dismissIntro = useCallback(async () => {
    setState((s) => ({ ...s, introDismissedAt: new Date().toISOString() }));
    await fetch("/api/onboarding/mein-konto-intro/dismiss", { method: "POST" });
  }, []);

  const markVisited = useCallback(async () => {
    setState((s) => s.firstVisitedAt ? s : { ...s, firstVisitedAt: new Date().toISOString() });
    await fetch("/api/onboarding/mein-konto-intro/mark-visited", { method: "POST" });
  }, []);

  return (
    <Ctx.Provider value={{ ...state, dismissIntro, markVisited }}>
      {children}
    </Ctx.Provider>
  );
}

export function useMeinKontoOnboarding(): OnboardingContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Fallback fuer Komponenten die ausserhalb des Providers gemountet
    // werden (z.B. Test-Renderings, Storybook). Verhalten = "nichts zu tun".
    return {
      introDismissedAt: new Date().toISOString(),
      firstVisitedAt: new Date().toISOString(),
      ready: true,
      dismissIntro: async () => {},
      markVisited: async () => {},
    };
  }
  return ctx;
}
