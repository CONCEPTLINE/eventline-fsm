"use client";

// Permissions + Profile-Context fuer die ganze (app)/-Seitenleiste.
//
// EIN Loader im Provider, alle Sub-Komponenten konsumieren via Hook.
// Vorher gabs zwei Loader-Pfade (Layout selbst + dieser Provider) und
// jeder Page-Mount hat profiles + roles doppelt geladen.
//
// Datenquelle: /api/me. Der Endpoint nutzt server-seitig requireUser() +
// effectiveUserId — bei aktiver Developer-Mode-Impersonation kommt hier
// das PROFILE + die PERMISSIONS des ZIEL-Users zurueck, sonst die des
// echten Session-Users. Ohne Impersonation ist das Verhalten identisch
// zum alten direkten Supabase-Query.
//
// Re-Load-Trigger:
//   - Auth-Statuswechsel (Login/Logout/Refresh) via Supabase-Listener
//   - Custom-Event "developer-mode-changed" — feuert wenn der Admin die
//     Impersonation startet/wechselt/beendet (siehe view-as-overlay.tsx)
//   - NICHT bei Route-Wechsel — Profile + Permissions sind stabil.

import { createContext, useContext, useEffect, useState, useMemo, useCallback, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { hasPermission, type PermissionSlug } from "@/lib/permissions";
import type { Profile } from "@/types";

interface AppContextState {
  profile: Profile | null;
  permissions: string[];
  role: string;
  ready: boolean;
  loadError: string | null;
}

const PermissionsContext = createContext<AppContextState | null>(null);

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppContextState>({
    profile: null,
    permissions: [],
    role: "",
    ready: false,
    loadError: null,
  });
  const supabase = createClient();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/me", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (signal?.aborted) return;
      if (res.status === 401) {
        setState({ profile: null, permissions: [], role: "", ready: true, loadError: null });
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setState({
          profile: null, permissions: [], role: "", ready: true,
          loadError: `Profil-Laden fehlgeschlagen (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
        });
        return;
      }
      const json = (await res.json()) as {
        profile: Profile | null;
        permissions: string[];
        role: string;
      };
      if (signal?.aborted) return;
      if (!json.profile) {
        setState({
          profile: null, permissions: [], role: "", ready: true,
          loadError: "Profil nicht gefunden für diesen User.",
        });
        return;
      }
      setState({
        profile: json.profile,
        permissions: Array.isArray(json.permissions) ? json.permissions : [],
        role: json.role ?? "",
        ready: true,
        loadError: null,
      });
    } catch (err) {
      if (signal?.aborted) return;
      // AbortError → normaler Cleanup, kein Fehler.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setState({
        profile: null, permissions: [], role: "", ready: true,
        loadError: err instanceof Error ? err.message : "Unbekannter Fehler beim Laden",
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);

    // Re-Load bei Auth-Wechsel (Login/Logout in anderem Tab) — verhindert
    // dass die App mit alter Profile-Sicht weiterlaeuft nachdem der User
    // sich anders eingeloggt hat.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        void load();
      }
    });

    // Re-Load bei Impersonation-Wechsel — der ViewAs-Overlay feuert dieses
    // Event beim Start/Wechsel/Beenden. Sidebar/Overlay-Layouts reloaden
    // die Seite sowieso, aber Sub-Komponenten die noch gemounted sind
    // (z.B. das Overlay selbst) bekommen so eine frische Perspektive.
    function onDevModeChange() {
      void load();
    }
    window.addEventListener("developer-mode-changed", onDevModeChange);

    return () => {
      controller.abort();
      subscription.unsubscribe();
      window.removeEventListener("developer-mode-changed", onDevModeChange);
    };
  }, [supabase, load]);

  // Memo-isiertes Value damit Konsumenten nicht bei jedem Provider-Render
  // re-rendern obwohl sich nichts geaendert hat.
  const value = useMemo(() => state, [state]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

/**
 * Permissions-Hook. Liefert can()-Helper + Profile + Meta.
 * Funktioniert nur innerhalb eines PermissionsProvider.
 */
export function usePermissions() {
  const ctx = useContext(PermissionsContext);
  const state = ctx ?? {
    profile: null,
    permissions: [] as string[],
    role: "",
    ready: false,
    loadError: null,
  };

  // Weiche Typisierung: PermissionSlug liefert Autocomplete + Doku fuer
  // alle bekannten Slugs, `(string & {})` haelt dynamisch gebaute Strings
  // compile-clean (harte Typisierung kommt spaeter).
  function can(perm: PermissionSlug | (string & {})): boolean {
    return hasPermission(state.permissions, state.role, perm);
  }

  return {
    can,
    ready: state.ready,
    role: state.role,
    permissions: state.permissions,
    profile: state.profile,
    loadError: state.loadError,
  };
}
