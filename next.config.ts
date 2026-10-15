import type { NextConfig } from "next";

// Supabase-Origin aus der Env ableiten (prod/preview identisch, aber robust).
const SUPA = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://uxtotpniwbwyoznwkygd.supabase.co").replace(/\/+$/, "");
const SUPA_WSS = SUPA.replace(/^https:/, "wss:");

// Voller CSP — ENFORCING (seit 2026-10-15). Zuvor als Report-Only auf Prod
// verifiziert: 0 Verstoesse ueber die gesamte App (Techniker + Admin, alle
// Seiten inkl. Realtime-WebSocket). Google-Maps (nur mit API-Key aktiv, in Prod
// nicht gesetzt) und die Akquise-Karte (nur auf Branch vertrieb-neu) sind in
// Prod nicht aktiv — ihre Quellen sind aber vorsorglich allowlisted, damit ein
// spaeteres Aktivieren nicht bricht.
//
// Quellen (aus dem Code ermittelt): Supabase REST+Realtime(wss), Google-Maps-
// JS (Adress-Autocomplete), OpenStreetMap-Tiles + Nominatim (Leaflet-Karte),
// PDF-Vorschau via iframe/blob, Service-Worker/Web-Push (worker/blob), Fonts
// gebuendelt (self) bzw. Google-Fonts-Fallback, Laenderflaggen flagcdn.
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  // 'unsafe-inline' bewusst: Next.js-Inline-Bootstrap + dynamisch injiziertes
  // Google-Maps-Skript. Kein externer Skript-CDN ausser Google Maps.
  `script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com`,
  // Inline-Styles ueberall (state-driven Hover-System) -> 'unsafe-inline' noetig.
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${SUPA} https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://maps.googleapis.com https://maps.gstatic.com https://*.gstatic.com https://*.googleapis.com https://*.google.com https://*.ggpht.com https://*.googleusercontent.com https://flagcdn.com`,
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self' ${SUPA} ${SUPA_WSS} https://nominatim.openstreetmap.org https://maps.googleapis.com https://*.googleapis.com`,
  "worker-src 'self' blob:",
  `frame-src 'self' blob: ${SUPA}`,
  "manifest-src 'self'",
  `media-src 'self' blob: ${SUPA}`,
  // CSP-Verstoesse an den eigenen Sammelpunkt melden: report-uri (breit
  // unterstuetzt, Fallback) + report-to (moderne Browser; Gruppe 'csp-endpoint'
  // via Reporting-Endpoints-Header unten definiert).
  "report-uri /api/csp-report",
  "report-to csp-endpoint",
].join("; ");

// Sicherheits-Header fuer ALLE Routen. Konservativ: nichts bricht an der App.
//   - X-Frame-Options / frame-ancestors  → Clickjacking unterbinden.
//   - X-Content-Type-Options: nosniff     → MIME-Sniffing aus.
//   - Referrer-Policy                      → keine vollen URLs an Fremdziele.
//   - Content-Security-Policy  → der VOLLE CSP, ENFORCING (blockt Fremdquellen).
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Content-Security-Policy",
    value: csp,
  },
  // Reporting-Gruppe 'csp-endpoint' fuer die report-to-Direktive im CSP.
  { key: "Reporting-Endpoints", value: 'csp-endpoint="/api/csp-report"' },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Service Worker nie cachen — sonst bleiben Clients auf einer alten
        // sw.js haengen und kriegen App-Updates verzoegert. Korrekter
        // Content-Type + Allowed-Scope fuer Root-Scope-Registrierung.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // Sicherheits-Header auf alle Routen anwenden.
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
