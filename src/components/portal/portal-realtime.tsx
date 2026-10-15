"use client";

// Portal-Realtime — schlanker Bruder der app-weiten Abos im (app)/layout:
// die Portale (partner/lieferant) brauchen nur die EIGENEN notifications
// live (fuer die NotificationsBell). Gleiche Event-Namen wie in der
// Haupt-App ("realtime:notifications", "realtime:status"), damit die Bell
// unveraendert funktioniert; faellt Realtime aus, greift ihr Polling.
// Abo-Mechanik (Token vor Beitritt, Status, Neuaufbau): src/lib/realtime.ts.

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { tabelleAbonnieren } from "@/lib/realtime";

export function PortalRealtime() {
  useEffect(() => {
    const supabase = createClient();
    let abmelden: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      abmelden = tabelleAbonnieren(supabase, {
        tabelle: "notifications",
        filter: `user_id=eq.${user.id}`,
        beiAenderung: (payload) => {
          window.dispatchEvent(new CustomEvent("realtime:notifications", { detail: payload }));
        },
        beiStatus: (ok, status) => {
          window.dispatchEvent(new CustomEvent("realtime:status", { detail: { ok, status } }));
        },
      });
    })();

    return () => {
      cancelled = true;
      abmelden?.();
    };
  }, []);

  return null;
}
