"use client";

// Ausloeser fuer das Senden der Warteschlange + Online-Hook.
//
// Gesendet wird nur im Seiten-Kontext (kein Background Sync — gibt es auf
// iOS nicht). Trigger: App-Start, window «online», Tab wieder sichtbar,
// Realtime-Kanal wieder verbunden (realtime:status ok:true). «Nach jedem
// Erfolg» laeuft die Reihe in sendeAlle() selbst weiter.

import { useSyncExternalStore } from "react";

/** Registriert alle Trigger; `run` wird sofort (App-Start) und bei jedem
 *  Ausloeser gerufen. Rueckgabe: Aufraeum-Funktion. */
export function registriereSyncTrigger(run: () => void): () => void {
  const beiOnline = () => run();
  const beiSichtbar = () => {
    if (document.visibilityState === "visible") run();
  };
  const beiRealtime = (e: Event) => {
    const detail = (e as CustomEvent<{ ok?: boolean }>).detail;
    if (detail?.ok) run();
  };
  window.addEventListener("online", beiOnline);
  document.addEventListener("visibilitychange", beiSichtbar);
  window.addEventListener("realtime:status", beiRealtime);
  // App-Start: als Mikrotask, damit der Aufrufer sein Setup abgeschlossen hat.
  const start = setTimeout(run, 0);
  return () => {
    clearTimeout(start);
    window.removeEventListener("online", beiOnline);
    document.removeEventListener("visibilitychange", beiSichtbar);
    window.removeEventListener("realtime:status", beiRealtime);
  };
}

// ---------------------------------------------------------------------------
// useOnline — navigator.onLine + online/offline-Events (SSR: true)
// ---------------------------------------------------------------------------

function abonniere(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}
function lies(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}
function liesServer(): boolean {
  return true;
}

export function useOnline(): boolean {
  return useSyncExternalStore(abonniere, lies, liesServer);
}
