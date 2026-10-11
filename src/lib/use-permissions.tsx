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
// Offline-Fallback: schlaegt /api/me mit einem Netzfehler fehl oder ist der
// Server nicht erreichbar (502/503/504), kommen Profil + Rechte aus dem
// Me-Cache (me-cache.ts, localStorage) — `profilAusCache: true`. Damit haben
// Stempeln und Rapport beim Offline-Kaltstart (PWA von iOS beendet, Seite aus
// dem Service-Worker-Cache) eine meId. Nie unter Impersonation, nie bei 401.
//
// Re-Load-Trigger:
//   - Auth-Statuswechsel (Login/Logout/Refresh) via Supabase-Listener
//   - Custom-Event "developer-mode-changed" — feuert wenn der Admin die
//     Impersonation startet/wechselt/beendet (siehe view-as-overlay.tsx)
//   - window "online" — ersetzt einen Cache-Stand durch den Server-Stand
//   - NICHT bei Route-Wechsel — Profile + Permissions sind stabil.

import { createContext, useContext, useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { hasPermission, type PermissionSlug } from "@/lib/permissions";
import { readMeCache, writeMeCache, clearMeCache } from "@/lib/me-cache";
import type { Profile } from "@/types";

export type SichtScope = "self" | "team" | "all";

interface AppContextState {
  profile: Profile | null;
  permissions: string[];
  role: string;
  /** Sichtbereich der Rolle (roles.scope). Admin = all. */
  scope: SichtScope;
  ready: boolean;
  loadError: string | null;
  /** true, wenn Profil + Rechte offline aus dem Me-Cache kommen (kein Server-Stand). */
  profilAusCache: boolean;
}

// Zustand ohne Profil (ausgeloggt, Fehler) — ready/loadError setzt der Aufrufer.
const OHNE_PROFIL = {
  profile: null,
  permissions: [] as string[],
  role: "",
  scope: "self" as SichtScope,
  profilAusCache: false,
};

const PermissionsContext = createContext<AppContextState | null>(null);

/** Hoechstens so lange auf /api/me warten (Vercel-Kaltstart + langsames
 *  Mobilnetz liegen deutlich darunter), danach Cache-Fallback. */
const ME_TIMEOUT_MS = 12_000;
/** Nach einem Cache-Fallback MIT Netz einmal spaeter nachladen, damit der
 *  Server-Stand den Cache ersetzt, sobald der Server wieder antwortet. */
const ME_RETRY_MS = 30_000;

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppContextState>({
    ...OHNE_PROFIL,
    ready: false,
    loadError: null,
  });
  const supabase = createClient();
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    // Server nicht erreichbar -> Me-Cache (readMeCache liefert unter
    // Impersonation nie etwas). Ohne Cache wie bisher loadError.
    const ausCacheOderFehler = (fehler: string) => {
      const cache = readMeCache();
      if (cache) {
        setState({
          profile: cache.profile,
          permissions: cache.permissions,
          role: cache.role,
          scope: cache.scope,
          ready: true,
          loadError: null,
          profilAusCache: true,
        });
        // Geraet meldet Netz (Server antwortet nur gerade nicht, Lie-Fi):
        // spaeter einmal nachladen. Ohne Netz uebernimmt das 'online'-Event.
        if (typeof navigator === "undefined" || navigator.onLine !== false) {
          if (retryRef.current) clearTimeout(retryRef.current);
          retryRef.current = setTimeout(() => {
            retryRef.current = null;
            void load();
          }, ME_RETRY_MS);
        }
        return;
      }
      setState({ ...OHNE_PROFIL, ready: true, loadError: fehler });
    };

    // «Lie-Fi» (WLAN verbunden, kein Internet): fetch haengt sonst
    // minutenlang statt zu werfen. Eigener Abbruch nach ME_TIMEOUT_MS, der
    // wie ein Netzfehler behandelt wird (Cache-Fallback). Kein
    // AbortSignal.any/timeout — fehlt auf aelteren iPhones.
    const zeit = new AbortController();
    const timer = setTimeout(() => zeit.abort(), ME_TIMEOUT_MS);
    const weiterreichen = () => zeit.abort();
    signal?.addEventListener("abort", weiterreichen, { once: true });
    try {
      let res: Response;
      try {
        res = await fetch("/api/me", {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: zeit.signal,
        });
      } catch (err) {
        if (signal?.aborted) return;
        if (zeit.signal.aborted) {
          ausCacheOderFehler("Keine Antwort vom Server (Zeitüberschreitung)");
          return;
        }
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Netzfehler: fetch wirft TypeError («Failed to fetch» / «Load failed»).
        if (err instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false)) {
          ausCacheOderFehler(err instanceof Error ? err.message : "Keine Verbindung");
          return;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", weiterreichen);
      }
      if (signal?.aborted) return;
      if (res.status === 401) {
        // Session weg: kein Cache-Fallback, Cache raus.
        clearMeCache();
        setState({ ...OHNE_PROFIL, ready: true, loadError: null });
        return;
      }
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        ausCacheOderFehler(`Profil-Laden fehlgeschlagen (${res.status})`);
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setState({
          ...OHNE_PROFIL, ready: true,
          loadError: `Profil-Laden fehlgeschlagen (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
        });
        return;
      }
      const json = (await res.json()) as {
        profile: Profile | null;
        permissions: string[];
        role: string;
        scope?: SichtScope;
      };
      if (signal?.aborted) return;
      if (!json.profile) {
        clearMeCache();
        setState({
          ...OHNE_PROFIL, ready: true,
          loadError: "Profil nicht gefunden für diesen User.",
        });
        return;
      }
      const permissions = Array.isArray(json.permissions) ? json.permissions : [];
      const role = json.role ?? "";
      const scope: SichtScope =
        json.scope === "team" || json.scope === "all" ? json.scope : (role === "admin" ? "all" : "self");
      // Server-Stand fuer Boot-Shell und Offline-Fallback ablegen.
      writeMeCache(json.profile, permissions, { role, scope });
      setState({
        profile: json.profile,
        permissions,
        role,
        scope,
        ready: true,
        loadError: null,
        profilAusCache: false,
      });
    } catch (err) {
      if (signal?.aborted) return;
      // AbortError → normaler Cleanup, kein Fehler.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setState({
        ...OHNE_PROFIL, ready: true,
        loadError: err instanceof Error ? err.message : "Unbekannter Fehler beim Laden",
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);

    // Re-Load bei Auth-Wechsel (Login/Logout in anderem Tab) — verhindert
    // dass die App mit alter Profile-Sicht weiterlaeuft nachdem der User
    // sich anders eingeloggt hat. Beim Logout zuerst den Me-Cache raus,
    // sonst wuerde ein Offline-Logout aus dem Cache «wiederauferstehen».
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") clearMeCache();
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

    // Wieder online -> Server-Stand holen; ersetzt einen Offline-Fallback aus
    // dem Cache (profilAusCache -> false) bzw. einen loadError ohne Cache.
    function onOnline() {
      void load();
    }
    window.addEventListener("online", onOnline);

    return () => {
      controller.abort();
      if (retryRef.current) clearTimeout(retryRef.current);
      subscription.unsubscribe();
      window.removeEventListener("developer-mode-changed", onDevModeChange);
      window.removeEventListener("online", onOnline);
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
  const state: AppContextState = ctx ?? {
    ...OHNE_PROFIL,
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
    scope: state.scope,
    permissions: state.permissions,
    profile: state.profile,
    /** Effektive User-ID (bei «Ansicht als» die des Ziel-Users). Fuer
     *  «meine»-Abfragen IMMER diese nehmen, nie auth.getUser() — der liefert
     *  den echten Session-User. */
    meId: state.profile?.id ?? null,
    loadError: state.loadError,
    /** Profil + Rechte stammen offline aus dem Me-Cache (kein Server-Stand). */
    profilAusCache: state.profilAusCache,
  };
}
