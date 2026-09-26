"use client";

// Portal-Realtime — schlanker Bruder des globalen Channels im (app)/layout:
// die Portale (partner/lieferant) brauchen nur die EIGENEN notifications
// live (fuer die NotificationsBell). Gleiche Event-Namen wie in der
// Haupt-App ("realtime:notifications", "realtime:status"), damit die Bell
// unveraendert funktioniert; faellt Realtime aus, greift ihr Polling.

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export function PortalRealtime() {
  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      channel = supabase
        .channel("portal-realtime")
        .on("postgres_changes", {
          event: "*", schema: "public", table: "notifications",
          filter: `user_id=eq.${user.id}`,
        }, (payload) => {
          window.dispatchEvent(new CustomEvent("realtime:notifications", { detail: payload }));
        })
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            window.dispatchEvent(new CustomEvent("realtime:status", { detail: { ok: false, status } }));
          } else if (status === "SUBSCRIBED") {
            window.dispatchEvent(new CustomEvent("realtime:status", { detail: { ok: true, status } }));
          }
        });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  return null;
}
