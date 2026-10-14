import type { NextConfig } from "next";

// Sicherheits-Header fuer ALLE Routen. Bewusst konservativ gewaehlt, damit
// nichts an der laufenden App bricht:
//   - X-Frame-Options / frame-ancestors  → Clickjacking (Login in fremdem
//     <iframe> einbetten) unterbinden.
//   - X-Content-Type-Options: nosniff     → MIME-Sniffing aus.
//   - Referrer-Policy                      → keine vollen URLs an Fremdziele.
//   - CSP NUR base-uri/frame-ancestors/object-src: schraenkt KEINE Ressourcen
//     (Skripte/Styles/Supabase-Connects) ein → kein Regressions-Risiko. Eine
//     vollstaendige script-src/connect-src-CSP braucht Vorschau-Tests und
//     kommt separat (siehe Rapport).
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Content-Security-Policy",
    value: "base-uri 'self'; frame-ancestors 'self'; object-src 'none'",
  },
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
