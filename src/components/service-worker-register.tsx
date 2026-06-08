"use client";

import { useEffect } from "react";

/**
 * Registriert den PWA-Service-Worker (/sw.js) — macht die App installierbar
 * (Android zeigt dann "App installieren") und aktiviert den Offline-Fallback.
 *
 * Nur in Production: im Dev-Modus wuerde ein cachender SW staendig zu
 * veralteten Next-Chunks fuehren. Registrierung erst nach "load", damit sie
 * das initiale Rendering nicht konkurrenziert.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Registrierung ist best-effort — ein Fehler darf die App nicht stoeren.
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
