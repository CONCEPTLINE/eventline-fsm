"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

interface BackButtonProps {
  /** Wohin gehen wenn keine In-App-History vorhanden ist (z.B. Direkt-Link). */
  fallbackHref?: string;
  /** Kompakte Variante fuer Form-Header. */
  size?: "sm" | "md";
}

// App-weiter Zurueck-Pfeil. Geht immer zur tatsaechlichen Vorseite zurueck
// (Browser-History) statt zu einem hardcodeten Pfad — wer aus dem Kalender
// auf einen Auftrag klickt, landet beim Zurueck wieder im Kalender, nicht
// auf der Auftrags-Liste.
//
// Auf Mobile mit sichtbarer border + bg damit's eindeutig als Button
// erkennbar ist (Touch-Screens haben keinen Hover-State der "klickbar"
// signalisiert). Desktop bleibt minimal — Hover-Highlight reicht da.
export function BackButton({ fallbackHref = "/dashboard", size = "md" }: BackButtonProps) {
  const router = useRouter();
  const padding = size === "sm" ? "p-1.5" : "p-2";
  const icon = size === "sm" ? "h-4 w-4" : "h-5 w-5";

  return (
    <button
      type="button"
      aria-label="Zurück"
      // In der (app)-Shell am Handy versteckt (globals.css, Handy-Schicht):
      // dort hat der mobile Kopf den Zurueck-Pfeil. Portale unberuehrt.
      data-back-button=""
      onClick={() => {
        // window.history.length === 1 heisst: Tab wurde direkt auf dieser Seite
        // geoeffnet (z.B. via geteilter Link). Dann router.back() = no-op,
        // also lieber zum Fallback navigieren.
        if (typeof window !== "undefined" && window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
      className={`${padding} rounded-lg shrink-0 border border-border bg-card md:border-transparent md:bg-transparent hover:bg-foreground/5 dark:hover:bg-foreground/10 transition-colors`}
    >
      <ArrowLeft className={icon} />
    </button>
  );
}
