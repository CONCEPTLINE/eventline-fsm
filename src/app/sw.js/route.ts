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
 *   - Navigations zu Feld-Seiten (Kern-Seiten + /auftraege/<id>[/rapport]):
 *     network-first → gecachte Seite desselben Pfads → /offline; antwortet
 *     das Netz nicht binnen 4 s (Lie-Fi), kommt die gecachte Seite;
 *     Kern-Seiten (/dashboard, /kalender, /todos, /auftraege, /stempelzeiten)
 *     werden beim Install vorgeladen (nur wenn eingeloggt, keine Redirects),
 *     jeweils samt der in der HTML referenzierten /_next/static-Dateien
 *   - alle anderen Navigations (Portale, Standorte, Vertrieb, Einstellungen …):
 *     Netz → /offline; werden nie im Cache abgelegt
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

// v2: Seiten-Eintraege nur noch fuer Feld-Seiten — der Praefix sorgt dafuer,
// dass Caches alter Builds mit beliebigen Seiten beim activate weggeraeumt
// werden, auch wenn die Build-Version gleich bleibt (z. B. "dev").
const CACHE = "eventline-v2-${version}";
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
// Feld-Seiten des Firmenportals, die offline aus dem Cache kommen duerfen:
// die Kern-Seiten oben plus Auftrag-Detail und Rapport
// (/auftraege/<id>, /auftraege/<id>/rapport). /auftraege/neu ist das
// Buero-Formular, kein Feld. Alles andere (Partner-/Lieferantenportal,
// Standorte, Vertrieb, Einstellungen, …) wird nie abgelegt — dort stehen
// servergerenderte Daten (Lohn, Kosten) und fremde Sitzungen im HTML.
const FELD_SEITE = /^\\/auftraege\\/(?!neu$)[^\\/]+(\\/rapport)?$/;
function istFeldSeite(pathname) {
  return PRECACHE_SEITEN.includes(pathname) || FELD_SEITE.test(pathname);
}

// In einer Seite referenzierte /_next/static-Dateien: Script-Tags, CSS-Links,
// Font-Preloads und die Chunk-Liste im RSC-Payload (dort stehen die Pfade in
// maskierten Anfuehrungszeichen — darum endet ein Treffer auch am Backslash).
// Nur gleiche Herkunft, nur /_next/static.
function statischeDateien(html) {
  const treffer = html.match(/\\/_next\\/static\\/[^"'\\s<>\\\\]+/g) || [];
  const urls = new Set();
  for (const t of treffer) {
    try {
      const u = new URL(t.replace(/&amp;/g, "&"), self.location.origin);
      if (u.origin === self.location.origin && u.pathname.startsWith("/_next/static/")) urls.add(u.href);
    } catch (_) {}
  }
  return [...urls];
}

// HTML-Huelle einer Feld-Seite ablegen UND die darin referenzierten
// /_next/static-Dateien — sonst startet die Seite offline ohne Scripts und
// bleibt beim Lade-Spinner. Schon abgelegte Dateien werden nicht erneut
// geholt; scheitert eine einzelne Datei, laufen die anderen weiter.
async function seiteVorladen(cache, url) {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok || res.redirected) return;
    const html = await res.clone().text();
    await cache.put(url, res);
    await Promise.allSettled(
      statischeDateien(html).map(async (datei) => {
        if (!(await cache.match(datei))) await cache.add(datei);
      })
    );
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

// Nachrichten vom Client:
//   "SKIP_WAITING"                 — manuelles Skip-Waiting (z.B. "Update jetzt"-Button)
//   {typ: "SEITE_VORLADEN", pfad}  — HTML-Huelle einer Feld-Seite samt ihrer
//     /_next/static-Dateien vorab ablegen (src/lib/offline/sw-vorladen.ts). Soft-Navigationen holen nur RSC, darum
//     kaeme z. B. /auftraege/<id>/rapport sonst nie in den Cache. Schluessel =
//     Pfad ohne Query, wie im navigate-Zweig; nur Feld-Seiten.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (!data || data.typ !== "SEITE_VORLADEN" || typeof data.pfad !== "string") return;
  let pathname;
  try {
    pathname = new URL(data.pfad, self.location.origin).pathname;
  } catch (_) {
    return;
  }
  if (!istFeldSeite(pathname)) return;
  event.waitUntil(
    caches.open(CACHE).then((cache) => seiteVorladen(cache, pathname)).catch(() => {})
  );
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

  // Navigation = echter Seitenaufruf (Hard-Load, PWA-Start). Next-Soft-
  // Navigationen holen nur die RSC-Antwort (?_rsc=, mode "cors") — die laeuft
  // hier nicht durch und wird nie gecacht; scheitert sie offline, faellt Next
  // auf eine harte Navigation zurueck und landet in diesem Zweig.
  if (request.mode === "navigate") {
    // Keine Feld-Seite: Netz, sonst /offline — nie ablegen.
    if (!istFeldSeite(url.pathname)) {
      event.respondWith(
        fetch(request).catch(() => caches.match("/offline").then((r) => r || Response.error()))
      );
      return;
    }
    // Feld-Seite: Netz → erfolgreiche, nicht umgeleitete Antwort unter dem
    // Pfad (ohne Query, z. B. ?tab=rapport) ablegen → offline der gecachte
    // Pfad → sonst /offline. Lie-Fi (Netzsymbol da, aber keine Antwort): fetch
    // wirft dann nicht, sondern haengt bis zum Timeout des Betriebssystems
    // (iOS ~60 s) — darum nach 4 s die gecachte Seite nehmen; das Netz laeuft
    // im Hintergrund weiter und legt die frische Seite fuers naechste Mal ab.
    // Ohne gecachte Seite wird weiter auf das Netz gewartet.
    const netz = fetch(request).then((res) => {
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)).catch(() => {});
      }
      return res;
    });
    event.waitUntil(netz.catch(() => {}));
    event.respondWith(
      Promise.race([netz, new Promise((r) => setTimeout(r, 4000))])
        .then(async (res) => res || (await caches.match(url.pathname)) || netz)
        .catch(async () => (await caches.match(url.pathname)) || (await caches.match("/offline")) || Response.error())
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
