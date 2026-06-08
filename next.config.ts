import type { NextConfig } from "next";

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
    ];
  },
};

export default nextConfig;
