// Sitzungs-Gedaechtnis des Dashboards. Lebt im Modul, also solange die App im
// Browser geladen ist (ein Hard-Reload leert alles); Soft-Navigationen
// zurueck aufs Dashboard finden es wieder. Drei Dinge gehoeren zusammen und
// werden zusammen geleert:
//   - Session-Cache: die letzte Antwort von /api/dashboard. Beim naechsten
//     Mount rendert die Seite SOFORT daraus (kein Skelett) und revalidiert
//     still im Hintergrund (stale-while-revalidate, der Fetch laeuft immer).
//   - Bereichs-Liste: aus ihr baut das Skelett (loading.tsx bei der
//     Navigation, Seite ohne Cache) dasselbe Raster wie die Daten, die gleich
//     kommen — ohne Kenntnis das volle Raster.
//   - Auftakt-Flag: Hochzaehlen und Ruhe-Haken (use-auftakt.ts) laufen nur
//     beim ersten echten Ladevorgang der Sitzung; aus dem Cache gerenderte
//     Mounts zeigen sofort den Endstand.
//
// Sicherheit: Logout/Login sind SOFT-Navigationen — ein Modul-Cache wuerde
// einen User-Wechsel im selben Tab ueberleben und dem naechsten User kurz
// fremde Daten (inkl. Lohn-Prognose) zeigen. Deshalb haengt ein Auth-Watcher
// am Supabase-Singleton: SIGNED_OUT / Session weg / andere User-ID leert
// alles sofort (wirkt auch cross-tab). sessionStorage wird bewusst NICHT
// genutzt — es wuerde den Logout ebenso ueberleben, haette aber keinen
// Clear-Hook. Server-seitig bleibt alles leer (geschrieben wird nur aus
// Client-Effects) — kein Cross-Request-Leak im Node-Prozess.

import { createClient } from "@/lib/supabase/client";
import type { DashboardBereichKey } from "@/lib/dashboard-bereiche";
import type { DashboardDaten } from "@/components/dashboard/typen";

let cache: { data: DashboardDaten; userId: string | null } | null = null;
let letzteBereiche: readonly DashboardBereichKey[] | null = null;
let auftaktGezeigt = false;
// Letzte bekannte Auth-User-ID — taggt neue Cache-Eintraege, damit ein
// User-Wechsel im selben Tab erkannt wird. null = (noch) unbekannt.
let cacheUserId: string | null = null;
let authWatcherStarted = false;

/** Letzte Antwort der Sitzung — null auf dem Server und beim ersten Besuch. */
export function gecachteDaten(): DashboardDaten | null {
  return cache?.data ?? null;
}

/** Bereichs-Liste der letzten Antwort fuer das Skelett; null = unbekannt. */
export function gemerkteBereiche(): readonly DashboardBereichKey[] | null {
  return letzteBereiche;
}

/** Lief der Auftakt in dieser Sitzung schon? Die Seite liest das beim Mount:
 *  true → sofort der Endstand, keine Animation. */
export function auftaktSchonGezeigt(): boolean {
  return auftaktGezeigt;
}

/** Frische Antwort merken: Cache und Bereichs-Liste. Mit der ersten Antwort
 *  der Sitzung laeuft der Auftakt (der Mount, der sie zeigt, hat ihn beim
 *  Mount freigegeben) — ab jetzt zeigen alle weiteren Mounts den Endstand. */
export function cacheSchreiben(daten: DashboardDaten): void {
  cache = { data: daten, userId: cacheUserId };
  letzteBereiche = daten.bereiche;
  auftaktGezeigt = true;
}

/** Alles vergessen — Cache, Bereichs-Liste und Auftakt-Flag. Der naechste
 *  Mount laedt wie ein erster Besuch (Skelett im vollen Raster, Auftakt). */
function cacheLeeren(): void {
  cache = null;
  letzteBereiche = null;
  auftaktGezeigt = false;
}

export function ensureCacheAuthWatcher(): void {
  if (authWatcherStarted || typeof window === "undefined") return;
  authWatcherStarted = true;
  createClient().auth.onAuthStateChange((event, session) => {
    const uid = session?.user?.id ?? null;
    if (event === "SIGNED_OUT" || uid === null) {
      // Konservativ: ohne Session nie gecachte Daten behalten.
      cacheLeeren();
      cacheUserId = null;
      return;
    }
    if (cache) {
      if (cache.userId === null) {
        // Cache wurde geschrieben bevor die erste Auth-Info da war.
        // /api/dashboard ist auth-gated — die Antwort gehoert diesem User.
        cache.userId = uid;
      } else if (cache.userId !== uid) {
        cacheLeeren(); // anderer User im selben Tab -> nie stale Fremd-Daten
      }
    }
    cacheUserId = uid;
  });
}
