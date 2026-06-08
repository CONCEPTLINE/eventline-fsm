/*
 * EVENTLINE FSM — Service Worker.
 *
 * Zweck: macht die App installierbar (Android "App installieren"-Button,
 * zuverlaessiger Standalone-Start) und liefert eine Offline-Fallback-Seite.
 *
 * BEWUSST KONSERVATIV — die App teilt sich eine Live-DB und ist
 * auth-gesichert. Darum wird NIE etwas gecached, das Userdaten enthaelt:
 *  - Navigationen (HTML-Seiten): immer network-first. Offline -> /offline.
 *    So sieht nie jemand veraltete oder fremde Daten aus dem Cache.
 *  - /api/* und /auth/*: nie abgefangen, immer direkt ans Netz.
 *  - Supabase (cross-origin): nie abgefangen (origin-Check faengt das ab).
 *  - Gecached wird nur Unveraenderliches: /_next/static/* (content-hashed)
 *    sowie Icons/Fonts/Bilder aus /public.
 *
 * Cache-Version bei groesseren Aenderungen hochzaehlen -> alter Cache wird
 * beim activate geloescht.
 */

const CACHE = "eventline-v1";
const PRECACHE = [
  "/offline",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // einzeln adden statt addAll: ein fehlendes Asset darf die ganze
      // Installation nicht abbrechen lassen.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isImmutableStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf)$/i.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Nur same-origin behandeln — Supabase & andere Drittseiten unberuehrt.
  if (url.origin !== self.location.origin) return;

  // API & Auth nie cachen/abfangen.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Seiten-Navigationen: network-first, Offline-Fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/offline").then((r) => r || Response.error()))
    );
    return;
  }

  // Unveraenderliche statische Assets: cache-first, sonst nachladen & cachen.
  if (isImmutableStatic(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Alles andere: Browser-Default (kein respondWith).
});
