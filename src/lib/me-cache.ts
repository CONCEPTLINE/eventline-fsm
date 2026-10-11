// Me-Cache: letzte /api/me-Antwort auf dem Geraet (localStorage).
//
// Ein Schreiber, zwei Leser:
//   - PermissionsProvider (use-permissions.tsx) schreibt nach jeder
//     erfolgreichen /api/me-Antwort und liest den Cache als OFFLINE-FALLBACK:
//     Kaltstart ohne Netz (PWA von iOS beendet, Seite kommt aus dem Service-
//     Worker-Cache) -> fetch wirft -> Profil + Rechte aus dem Cache, damit
//     Stempeln und Rapport (Daten liegen lokal in IndexedDB) weiterlaufen.
//     Sobald das Geraet wieder online ist, ersetzt der Server-Stand den Cache.
//   - (app)/layout.tsx bootet die Shell (Sidebar + Skeleton) aus dem Cache,
//     waehrend der Provider im Hintergrund revalidiert.
//
// localStorage statt sessionStorage: sessionStorage stirbt mit dem Tab — und
// am Handy mit der beendeten PWA. Genau dann braucht der Offline-Kaltstart
// den Cache aber. Alte Eintraege (nur profile + permissions) bleiben lesbar:
// role kommt dann aus profile.role, scope aus der Rolle (Admin = all, sonst
// self).
//
// Sicherheits-Grenzen:
//   - NIE schreiben/lesen waehrend Impersonation (View-As-Cookie, non-httpOnly,
//     s. api-auth.ts) — sonst wuerde die Ziel-User-Perspektive einen Reload
//     ueberleben bzw. nach Beenden des View-As kurz falsch aufblitzen.
//   - Cache wird bei Logout/401/Profil-weg verworfen (Provider: 401, Profil
//     null, SIGNED_OUT; Layout: handleSignOut, Heartbeat-403, Inaktivitaets-
//     Logout, Redirect-zu-Login).
//   - Permissions sind reines UI-Gating — Datenzugriff bleibt server-seitig
//     via RLS enforced; ein stale Cache kann nichts freischalten. Offline gibt
//     es ohnehin keine Serverdaten, nur die lokalen IndexedDB-Warteschlangen.

import type { Profile } from "@/types";
import { readImpersonationCookie } from "@/lib/impersonation";
import { istPortalRolle } from "@/lib/portals";
import type { SichtScope } from "@/lib/use-permissions";

export const ME_CACHE_KEY = "eventline-me-cache-v2";

export type MeCache = {
  profile: Profile;
  permissions: string[];
  role: string;
  /** Sichtbereich der Rolle (roles.scope). Admin = all. */
  scope: SichtScope;
};

function scopeAusRolle(role: string): SichtScope {
  return role === "admin" ? "all" : "self";
}

export function readMeCache(): MeCache | null {
  if (typeof window === "undefined") return null;
  try {
    if (readImpersonationCookie()) {
      // Unter Impersonation nie aus dem Cache booten — und gleich raeumen.
      localStorage.removeItem(ME_CACHE_KEY);
      return null;
    }
    const raw = localStorage.getItem(ME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MeCache> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const prof = parsed.profile as Profile | undefined;
    if (!prof || typeof prof !== "object") return null;
    if (typeof prof.id !== "string" || typeof prof.full_name !== "string") return null;
    // Portal-Rollen (Partner/Lieferant/…) gehoeren nicht in die (app)-Shell
    // (Path-Guard leitet sie um) — kein Cache-Boot, lieber Spinner-Pfad.
    if (istPortalRolle(prof.role)) return null;
    if (!Array.isArray(parsed.permissions)) return null;
    // Fallbacks fuer Eintraege ohne role/scope (aelteres Format).
    const role =
      typeof parsed.role === "string" ? parsed.role : typeof prof.role === "string" ? prof.role : "";
    const scope =
      parsed.scope === "self" || parsed.scope === "team" || parsed.scope === "all"
        ? parsed.scope
        : scopeAusRolle(role);
    return {
      profile: prof,
      permissions: parsed.permissions.filter((p): p is string => typeof p === "string"),
      role,
      scope,
    };
  } catch {
    return null;
  }
}

/**
 * Letzte /api/me-Antwort ablegen. `meta` (role/scope) ist optional, damit
 * Aufrufer mit nur Profil + Rechten weiter funktionieren — dann wird role aus
 * profile.role abgeleitet und scope aus der Rolle (Admin = all, sonst self).
 */
export function writeMeCache(
  profile: Profile,
  permissions: string[],
  meta?: { role?: string; scope?: SichtScope },
) {
  if (typeof window === "undefined") return;
  try {
    if (readImpersonationCookie()) {
      // Impersonierte Perspektive nie persistieren.
      localStorage.removeItem(ME_CACHE_KEY);
      return;
    }
    const role = meta?.role ?? profile.role;
    const eintrag: MeCache = {
      profile,
      permissions,
      role,
      scope: meta?.scope ?? scopeAusRolle(role),
    };
    localStorage.setItem(ME_CACHE_KEY, JSON.stringify(eintrag));
  } catch {
    /* Storage blockiert/voll — Cache ist nur Beschleunigung + Offline-Fallback */
  }
}

export function clearMeCache() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ME_CACHE_KEY);
  } catch {
    /* noop */
  }
}
