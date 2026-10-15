"use client";

/**
 * LiveBroadcastReceiver — mounted im Layout jedes eingeloggten Users.
 *
 * Lauscht IMMER auf live:<own_user_id>. Solange kein Sender aktiv ist,
 * passiert nichts sichtbares. Sobald ein session:start reinkommt:
 *   - Fullscreen-Overlay mit "Admin arbeitet an deinem Konto" einblenden
 *   - Alle Klicks/Tastatur des Users sperren (pointer-events + Handler)
 *   - Fake-Cursor rendern der den Admin-Cursor spiegelt
 *   - Bei Click-Events: Ripple-Highlight am Ziel-Selektor
 *   - Bei Input-Events: nativen Value am Selektor setzen (React-safe)
 *   - Bei Focus: Element fokussieren
 *   - Bei Scroll: window.scrollTo
 *   - Bei Nav: router.push
 *
 * Timeout: wenn nach LIVE_HEARTBEAT_TIMEOUT_MS kein session:heartbeat
 * kommt, wird die Session automatisch beendet (Admin-Tab wurde
 * geschlossen ohne session:end).
 *
 * Kanal privat (Migration 341): beitreten darf nur das Konto selbst
 * (live:<eigene id>) und ein Admin mit Entwickler-Modus; senden nur dieser
 * Admin. Darum gilt IMMER die ECHTE Sitzung: unter «Ansicht als» lieferte
 * der Layout-Prop die simulierte Person — der Empfaenger belegte so im
 * Admin-Browser deren Kanal, und der Sender bekam beim Start denselben,
 * schon beigetretenen Kanal zurueck (kein SUBSCRIBED → nichts gesendet).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import {
  liveChannelName,
  LIVE_HEARTBEAT_TIMEOUT_MS,
  setNativeValue,
} from "@/lib/live-broadcast";
import { Eye } from "lucide-react";

interface Props {
  /** Gesetzt, sobald das Layout ein Profil hat (Schalter «eingeloggt»).
   *  Der Kanal selbst haengt an der ECHTEN Sitzung (siehe oben), nicht an
   *  dieser ID — unter «Ansicht als» ist sie die simulierte Person. */
  userId: string | null;
}

interface ClickRipple {
  id: number;
  x: number;
  y: number;
}

export function LiveBroadcastReceiver({ userId }: Props) {
  const supabase = createClient();
  const router = useRouter();
  const [isEmbed, setIsEmbed] = useState(false);
  const [active, setActive] = useState(false);

  // Im Mobile-Preview iframe NICHT rendern — sonst wuerden Receiver-
  // Overlays doppelt uebereinander stapeln (parent + iframe).
  useEffect(() => {
    if (typeof window !== "undefined" && window.self !== window.top) {
      setIsEmbed(true);
    }
  }, []);
  const [adminName, setAdminName] = useState<string>("Admin");
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [ripples, setRipples] = useState<ClickRipple[]>([]);
  const heartbeatRef = useRef<number>(0);
  const timeoutCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!userId) return;
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    const verdrahten = (kanal: RealtimeChannel) => kanal
      .on("broadcast", { event: "session:start" }, ({ payload }) => {
        setAdminName(String((payload as { admin_name?: string })?.admin_name ?? "Admin"));
        setActive(true);
        heartbeatRef.current = Date.now();
      })
      .on("broadcast", { event: "session:end" }, () => {
        setActive(false);
        setCursor(null);
      })
      .on("broadcast", { event: "session:heartbeat" }, () => {
        heartbeatRef.current = Date.now();
      })
      .on("broadcast", { event: "cursor" }, ({ payload }) => {
        const p = payload as { x: number; y: number };
        setCursor({ x: p.x, y: p.y });
      })
      .on("broadcast", { event: "click" }, ({ payload }) => {
        const p = payload as { x: number; y: number; sel: string };
        const id = Date.now() + Math.floor(performance.now());
        setRipples((rs) => [...rs, { id, x: p.x, y: p.y }]);
        // Ripple nach 600ms wieder wegraeumen
        setTimeout(() => {
          setRipples((rs) => rs.filter((r) => r.id !== id));
        }, 600);
        // Optional: das Element visuell aufblitzen lassen (subtle outline)
        try {
          const el = document.querySelector<HTMLElement>(p.sel);
          if (el) {
            const prev = el.style.outline;
            const prevOffset = el.style.outlineOffset;
            el.style.outline = "2px solid #dc2626";
            el.style.outlineOffset = "2px";
            setTimeout(() => {
              el.style.outline = prev;
              el.style.outlineOffset = prevOffset;
            }, 500);
          }
        } catch {}
      })
      .on("broadcast", { event: "input" }, ({ payload }) => {
        const p = payload as { sel: string; value: string };
        try {
          const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(p.sel);
          if (el && "value" in el) {
            setNativeValue(el, p.value);
          }
        } catch {}
      })
      .on("broadcast", { event: "focus" }, ({ payload }) => {
        const p = payload as { sel: string };
        try {
          const el = document.querySelector<HTMLElement>(p.sel);
          if (el) el.focus({ preventScroll: false });
        } catch {}
      })
      .on("broadcast", { event: "scroll" }, ({ payload }) => {
        const p = payload as { sy: number; sx: number };
        window.scrollTo({ top: p.sy, left: p.sx, behavior: "auto" });
      })
      .on("broadcast", { event: "nav" }, ({ payload }) => {
        const p = payload as { path: string };
        const current = window.location.pathname + window.location.search;
        if (p.path && p.path !== current) {
          router.push(p.path);
        }
      });

    (async () => {
      // ECHTE Sitzung (nicht die simulierte Person, siehe oben).
      const { data: { session } } = await supabase.auth.getSession();
      const echteId = session?.user?.id;
      if (cancelled || !echteId) return;
      channel = verdrahten(
        supabase.channel(liveChannelName(echteId), {
          config: { private: true, broadcast: { self: false, ack: false } },
        }),
      );
      channel.subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId, supabase, router]);

  // Heartbeat-Timeout: wenn Admin-Tab ohne session:end geschlossen wurde,
  // beenden wir die Session nach LIVE_HEARTBEAT_TIMEOUT_MS ohne Heartbeat.
  useEffect(() => {
    if (!active) return;
    timeoutCheckRef.current = setInterval(() => {
      if (Date.now() - heartbeatRef.current > LIVE_HEARTBEAT_TIMEOUT_MS) {
        setActive(false);
        setCursor(null);
      }
    }, 3000);
    return () => {
      if (timeoutCheckRef.current) clearInterval(timeoutCheckRef.current);
    };
  }, [active]);

  // Input-Lock beim User: Klicks/Tastatur waehrend Session unterdruecken.
  useEffect(() => {
    if (!active) return;
    function block(e: Event) {
      // Overlay-Klicks (data-live-allow) durchlassen — falls wir spaeter
      // einen "Session abbrechen"-Button auf User-Seite anbieten wollen.
      const t = e.target as HTMLElement | null;
      if (t && t.closest("[data-live-allow]")) return;
      e.stopPropagation();
      e.preventDefault();
    }
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("click", block, opts);
    window.addEventListener("mousedown", block, opts);
    window.addEventListener("keydown", block, opts);
    window.addEventListener("keyup", block, opts);
    window.addEventListener("keypress", block, opts);
    window.addEventListener("input", block, opts);
    window.addEventListener("change", block, opts);
    return () => {
      window.removeEventListener("click", block, opts);
      window.removeEventListener("mousedown", block, opts);
      window.removeEventListener("keydown", block, opts);
      window.removeEventListener("keyup", block, opts);
      window.removeEventListener("keypress", block, opts);
      window.removeEventListener("input", block, opts);
      window.removeEventListener("change", block, opts);
    };
  }, [active]);

  if (isEmbed) return null;
  if (!active) return null;

  return (
    <>
      {/* Fullscreen-Overlay — semi-transparent, blockt keine Sicht auf
          die UI, macht aber sichtbar dass etwas los ist. pointer-events
          ist auch geblockt via useEffect oben, doppelt gemoppelt. */}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2000,
          background: "color-mix(in oklab, #dc2626 8%, transparent)",
          border: "3px solid #dc2626",
          pointerEvents: "none",
        }}
      />
      {/* Info-Chip oben in der Mitte */}
      <div
        style={{
          position: "fixed",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 2001,
          background: "#dc2626",
          color: "white",
          padding: "6px 14px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 600,
          boxShadow: "0 4px 14px rgba(220, 38, 38, 0.4)",
          pointerEvents: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Eye style={{ width: 14, height: 14 }} />
        {adminName} arbeitet gerade an deinem Konto — Eingaben gesperrt
      </div>
      {/* Admin-Cursor spiegeln */}
      {cursor && (
        <div
          style={{
            position: "fixed",
            top: cursor.y,
            left: cursor.x,
            zIndex: 2002,
            pointerEvents: "none",
            transform: "translate(-2px, -2px)",
            transition: "top 60ms linear, left 60ms linear",
          }}
        >
          {/* SVG-Pfeil in rot damit klar zuordenbar */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 3 L4 19 L9 15 L12 21 L15 20 L12 14 L18 14 Z"
              fill="#dc2626"
              stroke="white"
              strokeWidth="1"
            />
          </svg>
          <span
            style={{
              position: "absolute",
              top: 22,
              left: 18,
              background: "#dc2626",
              color: "white",
              fontSize: 10,
              fontWeight: 600,
              padding: "2px 6px",
              borderRadius: 4,
              whiteSpace: "nowrap",
            }}
          >
            {adminName}
          </span>
        </div>
      )}
      {/* Click-Ripples */}
      {ripples.map((r) => (
        <span
          key={r.id}
          style={{
            position: "fixed",
            top: r.y - 20,
            left: r.x - 20,
            width: 40,
            height: 40,
            borderRadius: 999,
            border: "2px solid #dc2626",
            zIndex: 2001,
            pointerEvents: "none",
            animation: "live-ripple 600ms ease-out forwards",
          }}
        />
      ))}
      <style>{`
        @keyframes live-ripple {
          from { transform: scale(0.3); opacity: 1; }
          to   { transform: scale(1.5); opacity: 0; }
        }
      `}</style>
    </>
  );
}
