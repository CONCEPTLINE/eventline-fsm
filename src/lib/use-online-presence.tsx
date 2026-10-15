"use client";

/**
 * PresenceProvider — trackt den ECHTEN eingeloggten User (nicht den
 * impersonierten) in einem globalen Supabase-Realtime-Presence-Channel
 * `app-presence`. Jeder Konsument bekommt via `useOnlinePresence()` ein
 * `Set<string>` mit den user_ids die gerade online sind.
 *
 * Wichtig zum Impersonation-Fall:
 *   - `supabase.auth.getUser()` liefert immer den ECHTEN Session-User,
 *     unabhaengig von aktivem View-As / impersonate-Cookie. Der Presence-
 *     Payload nutzt diese ID — sonst wuerde ein impersonierter Partner
 *     als "online" erscheinen, obwohl dessen eigenes Konto gerade gar
 *     nicht offen ist.
 *
 * iframe-Skip: Mobile-Preview embedded die App in einem iframe. Der
 * Provider skippt dort — sonst wuerde derselbe User (durch den doppelten
 * Mount) mehrfach als online erscheinen (jeweils eigene presence_ref).
 * Der Presence-Key entdupliziert das zwar automatisch (mehrere Refs, ein
 * User), aber wir sparen uns die WSS-Verbindung im iframe.
 *
 * Nur interne Konten (Befund 2026-10-15): Portal-Konten (Partner,
 * Lieferant) erhielten ueber diesen Kanal die IDs aller online Mitarbeiter.
 * Jetzt tritt nur bei, wer is_internal_user() ist — und der Kanal ist
 * privat: die Policies auf realtime.messages (Migration 337) lassen nur
 * interne Konten lesen und sich melden, auch wenn ein Portal-Konto (alter
 * Tab, eigenes Skript) es direkt versucht. Portal-Konten erscheinen darum
 * auch nicht mehr als «online» im Ansicht-als-Panel.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

const PRESENCE_CHANNEL = "app-presence";

// Payload muss `{ [key: string]: any }` erfuellen (Constraint von
// supabase.channel.track()). Wir setzen es als indexbaren Type auf um
// beim Aufruf ohne `any`-Cast durchzukommen.
type PresencePayload = {
  user_id: string;
  joined_at: string;
  [key: string]: string;
};

const OnlinePresenceContext = createContext<Set<string>>(new Set<string>());

export function PresenceProvider({ children }: { children: ReactNode }) {
  const supabase = createClient();
  const [online, setOnline] = useState<Set<string>>(() => new Set<string>());
  const [isEmbed, setIsEmbed] = useState(false);

  // Im iframe (Mobile-Preview) skippen — genau wie ViewAsOverlay.
  useEffect(() => {
    if (typeof window !== "undefined" && window.self !== window.top) {
      setIsEmbed(true);
    }
  }, []);

  useEffect(() => {
    if (isEmbed) return;

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      // ECHTER Session-User — nicht der impersonierte. Das ist die harte
      // Anforderung an diesen Provider: wer ist WIRKLICH am Rechner, nicht
      // wer wird gerade simuliert.
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      // Portal-Konten treten gar nicht erst bei (serverseitig zusaetzlich
      // durch die Policy gesperrt, siehe oben).
      const { data: intern, error: internFehler } = await supabase.rpc("is_internal_user");
      if (cancelled || internFehler || intern !== true) return;

      const key = user.id;
      channel = supabase.channel(PRESENCE_CHANNEL, {
        config: { private: true, presence: { key } },
      });

      const recompute = () => {
        if (!channel) return;
        const state = channel.presenceState<PresencePayload>();
        const ids = new Set<string>();
        for (const presenceKey of Object.keys(state)) {
          const entries = state[presenceKey];
          if (!entries) continue;
          for (const entry of entries) {
            if (typeof entry.user_id === "string" && entry.user_id.length > 0) {
              ids.add(entry.user_id);
            }
          }
        }
        setOnline(ids);
      };

      channel
        .on("presence", { event: "sync" }, recompute)
        .on("presence", { event: "join" }, recompute)
        .on("presence", { event: "leave" }, recompute)
        .subscribe(async (status) => {
          if (status !== "SUBSCRIBED") return;
          const payload: PresencePayload = {
            user_id: user.id,
            joined_at: new Date().toISOString(),
          };
          try {
            await channel!.track(payload);
          } catch {
            // best-effort — bei WSS-Ausfall bleibt die UI-Anzeige
            // einfach leer, kein User-facing Fehler.
          }
        });
    })();

    return () => {
      cancelled = true;
      if (channel) {
        // Untrack + removeChannel — beides best-effort. Wenn die
        // Verbindung schon weg ist, wuerde untrack rejecten.
        channel.untrack().catch(() => {});
        supabase.removeChannel(channel);
        channel = null;
      }
    };
  }, [isEmbed, supabase]);

  return (
    <OnlinePresenceContext.Provider value={online}>
      {children}
    </OnlinePresenceContext.Provider>
  );
}

/** Set aller user_ids die gerade in irgendeinem Tab online sind. */
export function useOnlinePresence(): Set<string> {
  return useContext(OnlinePresenceContext);
}
