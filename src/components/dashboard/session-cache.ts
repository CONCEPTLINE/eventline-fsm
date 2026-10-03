// Sitzungs-Gedaechtnis des Dashboards. Lebt im Modul, also solange die App im
// Browser geladen ist (ein Hard-Reload leert alles); Soft-Navigationen
// zurueck aufs Dashboard finden es wieder. Vier Dinge gehoeren zusammen und
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
//   - Todo-Aenderungen («Meine Todos»): Abhaken und Rueckgaengig fuehren den
//     Cache sofort nach (eine abgehakte Todo erscheint beim Zurueckkommen
//     nicht wieder) und bleiben gemerkt, bis eine Antwort sie sicher kennt —
//     siehe Abschnitt unten.
//
// Sicherheit: Logout/Login sind SOFT-Navigationen — ein Modul-Cache wuerde
// einen User-Wechsel im selben Tab ueberleben und dem naechsten User kurz
// fremde Daten (inkl. Lohn-Prognose) zeigen. Deshalb haengt ein Auth-Watcher
// am Supabase-Singleton: SIGNED_OUT / Session weg / andere User-ID leert
// alles sofort (wirkt auch cross-tab). sessionStorage wird bewusst NICHT
// genutzt — es wuerde den Logout ebenso ueberleben, haette aber keinen
// Clear-Hook. Server-seitig bleibt alles leer (geschrieben wird nur aus
// Client-Effects und Klicks) — kein Cross-Request-Leak im Node-Prozess.

import { createClient } from "@/lib/supabase/client";
import type { DashboardBereichKey } from "@/lib/dashboard-bereiche";
import type { DashboardDaten } from "@/components/dashboard/typen";
import { enthaeltTodo, mitTodoStatus, type TodoStatus } from "@/components/dashboard/todo-stand";

/** gespeichert: Zeitpunkt der Bestaetigung (Date.now), null = Speichern laeuft. */
type TodoAenderung = { status: TodoStatus; gespeichert: number | null };
type TodoHoerer = (id: string, status: TodoStatus) => void;

let cache: { data: DashboardDaten; userId: string | null } | null = null;
let letzteBereiche: readonly DashboardBereichKey[] | null = null;
let auftaktGezeigt = false;
const todoAenderungen = new Map<string, TodoAenderung>();
const todoHoerer = new Set<TodoHoerer>();
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

/** Alles vergessen — Cache, Bereichs-Liste, Auftakt-Flag und Todo-
 *  Aenderungen. Der naechste Mount laedt wie ein erster Besuch (Skelett im
 *  vollen Raster, Auftakt). */
function cacheLeeren(): void {
  cache = null;
  letzteBereiche = null;
  auftaktGezeigt = false;
  todoAenderungen.clear();
}

// ---------------------------------------------------------------------------
// Todo-Aenderungen vom Dashboard («Meine Todos»: Abhaken, Rueckgaengig)
// ---------------------------------------------------------------------------
// Abhaken ist optimistisch: Cache und sichtbare Seite zeigen den neuen Status,
// bevor er gespeichert ist. Eine Antwort von /api/dashboard, deren Abruf vor
// dem Speichern startete, kennt die Aenderung womoeglich noch nicht — darum
// bleibt jede Aenderung gemerkt, bis ein Abruf sie sicher enthaelt (gestartet
// nach dem bestaetigten Speichern), und wird bis dahin auf jede Antwort
// angewendet. Die gerade sichtbare Seite hoert mit — auch bei «Rückgängig»
// aus einem Toast, dessen Dashboard inzwischen weggeklickt und neu geoeffnet
// wurde.

function todoMelden(id: string, status: TodoStatus): void {
  if (cache) cache = { ...cache, data: mitTodoStatus(cache.data, id, status) };
  for (const h of todoHoerer) h(id, status);
}

/** Neuen Status einer Todo merken, den Cache nachfuehren und die sichtbare
 *  Seite informieren. gespeichert=false: optimistisch, das Speichern laeuft
 *  noch (danach todoGespeichert bzw. todoVerworfen). */
export function todoStatusSetzen(id: string, status: TodoStatus, gespeichert: boolean): void {
  todoAenderungen.set(id, { status, gespeichert: gespeichert ? Date.now() : null });
  todoMelden(id, status);
}

/** Speichern bestaetigt: Abrufe, die ab jetzt starten, kennen den Stand. */
export function todoGespeichert(id: string): void {
  const a = todoAenderungen.get(id);
  if (!a) return;
  todoAenderungen.set(id, { ...a, gespeichert: Date.now() });
  // Nochmals melden: fehlt der Seite eine wieder geoeffnete Todo inzwischen
  // (Antwort von vor dem Speichern), laedt sie jetzt nach.
  todoMelden(id, a.status);
}

/** Speichern fehlgeschlagen: zurueck auf den alten Status, nichts merken. */
export function todoVerworfen(id: string, alterStatus: TodoStatus): void {
  todoAenderungen.delete(id);
  todoMelden(id, alterStatus);
}

/** Frische Antwort mit den gemerkten Aenderungen abgleichen. Was vor dem
 *  Start dieses Abrufs gespeichert war, kennt die Antwort schon — das wird
 *  vergessen. fehlt: eine gespeichert wieder geoeffnete Todo ist nicht
 *  dabei, weil der Abruf vor dem Speichern startete — dann nochmals laden. */
export function todoAenderungenAnwenden(
  daten: DashboardDaten,
  gestartet: number,
): { daten: DashboardDaten; fehlt: boolean } {
  let d = daten;
  let fehlt = false;
  for (const [id, a] of todoAenderungen) {
    if (a.gespeichert !== null && a.gespeichert <= gestartet) {
      todoAenderungen.delete(id);
    } else if (enthaeltTodo(d, id)) {
      d = mitTodoStatus(d, id, a.status);
    } else if (a.status === "offen" && a.gespeichert !== null && d.todos) {
      fehlt = true;
    }
  }
  return { daten: d, fehlt };
}

/** Die sichtbare Seite hoert auf Todo-Aenderungen; gibt das Abmelden zurueck. */
export function todoAenderungenAbonnieren(h: TodoHoerer): () => void {
  todoHoerer.add(h);
  return () => {
    todoHoerer.delete(h);
  };
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
