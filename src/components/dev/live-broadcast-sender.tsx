"use client";

/**
 * LiveBroadcastSender — mounted im Admin-Browser, sendet dessen Interactions
 * an den Broadcast-Channel des impersonierten Users. Nur aktiv wenn:
 *   - Admin ist impersonating (Cookie gesetzt)
 *   - Live-Mode wurde bewusst gestartet (via ViewAsOverlay)
 *
 * Der Sender-Zustand wird via CustomEvent 'live-broadcast:toggle' vom
 * ViewAsOverlay gesteuert (start/stop). Beim mount hoert er darauf und
 * startet/stoppt sein Subscription+Interval sauber.
 */

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  liveChannelName,
  LIVE_HEARTBEAT_MS,
  LIVE_CURSOR_THROTTLE_MS,
  cssPath,
} from "@/lib/live-broadcast";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface Props {
  /** Impersoniert gerade — kommt aus dem ViewAsOverlay. */
  targetUserId: string | null;
  /** Live-Mode wurde vom User bewusst aktiviert. */
  liveActive: boolean;
  /** Anzeige-Name des Admins fuer session:start payload. */
  adminName: string;
}

export function LiveBroadcastSender({ targetUserId, liveActive, adminName }: Props) {
  const supabase = createClient();
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [ready, setReady] = useState(false);
  const lastCursorTs = useRef(0);

  useEffect(() => {
    // Nur aktiv wenn beides erfuellt ist. Aufraeumen wenn eins wegfaellt.
    if (!targetUserId || !liveActive) {
      const c = channelRef.current;
      if (c) {
        // 'session:end' broadcasten damit Empfaenger sofort weiss dass es
        // vorbei ist — nicht erst nach heartbeat-Timeout.
        c.send({ type: "broadcast", event: "session:end", payload: {} }).catch(() => {});
        supabase.removeChannel(c);
        channelRef.current = null;
      }
      setReady(false);
      return;
    }

    // Privat (Migration 341): beitreten und senden darf nur ein Admin mit
    // Entwickler-Modus; das Ziel-Konto empfaengt in seinem eigenen Browser.
    const channel = supabase.channel(liveChannelName(targetUserId), {
      config: { private: true, broadcast: { self: false, ack: false } },
    });
    channelRef.current = channel;
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setReady(true);
        // Erst-Broadcast: session:start damit User sofort weiss dass Admin
        // grade live ist.
        channel.send({ type: "broadcast", event: "session:start", payload: { admin_name: adminName } }).catch(() => {});
      }
    });

    return () => {
      channel.send({ type: "broadcast", event: "session:end", payload: {} }).catch(() => {});
      supabase.removeChannel(channel);
      channelRef.current = null;
      setReady(false);
    };
  }, [targetUserId, liveActive, adminName, supabase]);

  // Heartbeat alle 5s damit User's Client Session-Timeout messen kann.
  useEffect(() => {
    if (!ready) return;
    const iv = setInterval(() => {
      channelRef.current?.send({ type: "broadcast", event: "session:heartbeat", payload: {} }).catch(() => {});
    }, LIVE_HEARTBEAT_MS);
    return () => clearInterval(iv);
  }, [ready]);

  // Cursor
  useEffect(() => {
    if (!ready) return;
    function onMove(e: MouseEvent) {
      const now = performance.now();
      if (now - lastCursorTs.current < LIVE_CURSOR_THROTTLE_MS) return;
      lastCursorTs.current = now;
      channelRef.current?.send({
        type: "broadcast",
        event: "cursor",
        payload: { x: e.clientX, y: e.clientY },
      }).catch(() => {});
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [ready]);

  // Click
  useEffect(() => {
    if (!ready) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Element | null;
      channelRef.current?.send({
        type: "broadcast",
        event: "click",
        payload: { x: e.clientX, y: e.clientY, sel: cssPath(target) },
      }).catch(() => {});
    }
    window.addEventListener("click", onClick, { capture: true });
    return () => window.removeEventListener("click", onClick, { capture: true } as EventListenerOptions);
  }, [ready]);

  // Input (input + textarea + select + contenteditable)
  useEffect(() => {
    if (!ready) return;
    function onInput(e: Event) {
      const t = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (!t) return;
      const sel = cssPath(t);
      const value =
        t.tagName === "SELECT" ? (t as HTMLSelectElement).value
        : (t as HTMLInputElement).value;
      channelRef.current?.send({
        type: "broadcast",
        event: "input",
        payload: { sel, value },
      }).catch(() => {});
    }
    window.addEventListener("input", onInput, { capture: true });
    window.addEventListener("change", onInput, { capture: true });
    return () => {
      window.removeEventListener("input", onInput, { capture: true } as EventListenerOptions);
      window.removeEventListener("change", onInput, { capture: true } as EventListenerOptions);
    };
  }, [ready]);

  // Focus
  useEffect(() => {
    if (!ready) return;
    function onFocus(e: FocusEvent) {
      const t = e.target as Element | null;
      channelRef.current?.send({
        type: "broadcast",
        event: "focus",
        payload: { sel: cssPath(t) },
      }).catch(() => {});
    }
    window.addEventListener("focusin", onFocus, { capture: true });
    return () => window.removeEventListener("focusin", onFocus, { capture: true } as EventListenerOptions);
  }, [ready]);

  // Scroll (window)
  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    function onScroll() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        channelRef.current?.send({
          type: "broadcast",
          event: "scroll",
          payload: { sy: window.scrollY, sx: window.scrollX },
        }).catch(() => {});
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, [ready]);

  // Navigation (route-changes im SPA)
  useEffect(() => {
    if (!ready) return;
    let lastPath = window.location.pathname + window.location.search;
    function push(path: string) {
      channelRef.current?.send({
        type: "broadcast",
        event: "nav",
        payload: { path },
      }).catch(() => {});
    }
    // Initial senden (der Receiver hat evtl. gerade erst gestartet)
    push(lastPath);
    // popstate + pushState/replaceState monkey-patchen
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    function trigger() {
      const cur = window.location.pathname + window.location.search;
      if (cur !== lastPath) {
        lastPath = cur;
        push(cur);
      }
    }
    history.pushState = function (...args) {
      const r = origPush.apply(this, args as Parameters<typeof origPush>);
      trigger();
      return r;
    };
    history.replaceState = function (...args) {
      const r = origReplace.apply(this, args as Parameters<typeof origReplace>);
      trigger();
      return r;
    };
    window.addEventListener("popstate", trigger);
    return () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener("popstate", trigger);
    };
  }, [ready]);

  return null;
}
