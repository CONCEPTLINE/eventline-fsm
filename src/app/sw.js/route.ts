import { NextResponse } from "next/server";

/**
 * Service Worker — DYNAMISCH generiert pro Build.
 *
 * Warum nicht static (/public/sw.js)?
 *   - Ein statisches sw.js ist byte-identisch zwischen Builds → der Browser
 *     erkennt KEIN Update → der alte SW bleibt aktiv → User sieht alte App
 *     bis er manuell den Cache loescht. Nicht akzeptabel.
 *
 * Loesung: bei jedem Build wird die CACHE-Version aus VERCEL_GIT_COMMIT_SHA
 * gesetzt. Damit ist sw.js byte-different zwischen Deploys → Browser laedt
 * neue Version → install → activate → ServiceWorkerRegister im Client
 * triggert window.location.reload() via 'controllerchange' Event.
 *
 * Verhalten ist sonst identisch zum vorherigen /public/sw.js:
 *   - Navigations: network-first → gecachte Seite derselben URL → /offline;
 *     Kern-Seiten (/dashboard, /kalender, /todos, /auftraege, /stempelzeiten)
 *     werden beim Install vorgeladen (nur wenn eingeloggt, keine Redirects)
 *   - /api/* und /auth/*: nie abfangen
 *   - Supabase (cross-origin): nie abfangen
 *   - /_next/static/* und Bilder/Fonts: cache-first (immutable)
 */

export const dynamic = "force-dynamic";
export const runtime = "edge";

export async function GET() {
  const version =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ||
    process.env.NEXT_PUBLIC_BUILD_ID ||
    "dev";

  const sw = `// EVENTLINE FSM — Service Worker (build ${version})
// AUTO-GENERATED. Nicht direkt editieren — Quelle ist src/app/sw.js/route.ts.

const CACHE = "eventline-${version}";
const PRECACHE = [
  "/offline",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];
// App-Seiten fuer den Offline-Start (Handy: Stempeln, Einsaetze, Todos).
// Werden nur abgelegt, wenn die Antwort ok UND nicht umgeleitet ist — sonst
// laege hinter /dashboard die Login-Seite. Daten/API werden nie gecacht.
const PRECACHE_SEITEN = [
  "/dashboard",
  "/kalender",
  "/todos",
  "/auftraege",
  "/stempelzeiten",
];

async function seiteVorladen(cache, url) {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.ok && !res.redirected) await cache.put(url, res);
  } catch (_) {}
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.allSettled([
          ...PRECACHE.map((url) => cache.add(url)),
          ...PRECACHE_SEITEN.map((url) => seiteVorladen(cache, url)),
        ])
      )
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

// Client kann manuelles Skip-Waiting ausloesen (z.B. via "Update jetzt"-Button).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

// PUSH-EVENT: zeigt eine System-Notification an. Payload-Format:
//   { title, body, url, tag } — vom NotificationService gesendet.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || "EVENTLINE";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "eventline",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Klick auf eine Push-Notification: oeffnet die App auf dem url-Pfad.
// Wenn die App schon offen ist, fokussieren statt neuen Tab oeffnen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url || "/";
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of allClients) {
      if ("focus" in c) {
        c.navigate(url);
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

function isImmutableStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    /\\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf)$/i.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Navigation: Netz → sonst zuletzt gecachte Antwort derselben URL (ohne
  // Query) → sonst /offline. Erfolgreiche, nicht umgeleitete Seiten werden
  // fuer den naechsten Offline-Start abgelegt (nur Seiten — kein /api, kein
  // /auth, siehe oben; RSC-/Daten-Antworten laufen hier nicht durch).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches
            .match(request, { ignoreSearch: true })
            .then((r) => r || caches.match("/offline"))
            .then((r) => r || Response.error())
        )
    );
    return;
  }

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
});
`;

  return new NextResponse(sw, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Browser darf sw.js nicht aus seinem HTTP-Cache nehmen — er muss
      // immer den Server fragen damit neue Builds erkannt werden. Plus
      // Service-Worker-Allowed Header damit der SW im root-scope laufen darf
      // (auch wenn sein Pfad /sw.js ist).
      "Cache-Control": "no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
