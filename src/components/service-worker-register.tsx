"use client";

import { useEffect } from "react";

/**
 * PWA-Service-Worker Registration.
 *
 * KEIN Auto-Reload mehr — der VersionWatcher (src/components/version-
 * watcher.tsx) zeigt einen dezenten Toast "Neue Version verfuegbar"
 * mit "Neu laden"-Button. User entscheidet SELBST wann er reloaded,
 * damit laufende Eingaben/Speichervorgaenge nicht abbrechen (CLAUDE.md §8).
 *
 * Lifecycle:
 *  1. Initial-Load: registriert /sw.js mit updateViaCache='none' damit
 *     der Browser sw.js NIE aus seinem HTTP-Cache nimmt.
 *  2. Periodic Check (60s im Foreground) + Tab-Visibility: registration.
 *     update() pingt den Server; neuer SW wird im Hintergrund installiert.
 *  3. Nach Install feuert der SW-eigene skipWaiting() -> er wird aktiv.
 *     Die aktuelle Tab-Session bleibt aber auf ihrem alten Bundle;
 *     erst nach vom User initiiertem reload sieht sie die neue Version.
 *
 * Nur in Production.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;
    let intervalId: number | undefined;

    function handleVisibility() {
      if (document.visibilityState === "visible" && registration) {
        registration.update().catch(() => {});
      }
    }

    function register() {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((reg) => {
          registration = reg;
          intervalId = window.setInterval(() => {
            reg.update().catch(() => {});
          }, 60_000);
        })
        .catch(() => { /* best-effort */ });

      document.addEventListener("visibilitychange", handleVisibility);
    }

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      if (intervalId) window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  return null;
}
