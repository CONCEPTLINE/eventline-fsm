"use client";

/**
 * Meldet, wenn ein neuer Build deployt ist — als dezenter Hinweis mit
 * "Neu laden"-Button (KEIN automatisches Hard-Reload, das sonst laufende
 * Eingaben/Speichervorgänge abbrechen und Daten verlieren würde).
 * Vergleicht die eingebaute Build-SHA mit der live deployten (/api/version).
 * 1:1 aus conceptline-fsm portiert.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { BUILD_INFO } from "@/lib/build-info";

export function VersionWatcher() {
  const notified = useRef(false);

  useEffect(() => {
    const mySha: string = BUILD_INFO.sha;
    if (!mySha || mySha === "dev") return; // lokal/ohne SHA nichts tun

    async function check() {
      if (notified.current || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { sha?: string };
        if (data.sha && data.sha !== mySha) {
          notified.current = true;
          toast("Neue Version verfügbar", {
            description: "Lade neu, um auf dem aktuellen Stand zu sein.",
            action: { label: "Neu laden", onClick: () => window.location.reload() },
            duration: Infinity,
          });
        }
      } catch {
        // offline o.ä. — beim nächsten Mal erneut versuchen
      }
    }

    const iv = setInterval(check, 60_000);
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  return null;
}
