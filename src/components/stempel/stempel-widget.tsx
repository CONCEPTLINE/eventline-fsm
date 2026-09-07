"use client";

// Schwebende Stempel-Pille unten-rechts. Immer sichtbar im (app)-Layout
// (siehe layout.tsx). Verhalten:
//   - Eingestempelt: gruene Pille mit Live-Timer + Job/Beschreibung +
//     Stop-Button. Klick auf die Pille zeigt Details.
//   - Ausgestempelt: kompakte Aktions-Pille "Einstempeln" → oeffnet Modal.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock, Square, Briefcase, FileText, ChevronUp, Ticket } from "lucide-react";
import { useStempel, formatStempelDuration } from "@/lib/use-stempel";
import { StempelModal } from "./stempel-modal";
import { RateTierLiveSwitcher } from "./rate-tier-live-switcher";
import { NewTicketModal } from "@/components/tickets/new-ticket-modal";
import { usePermissions } from "@/lib/use-permissions";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

export function StempelWidget() {
  const { active, loading, clockOut } = useStempel();
  const { can } = usePermissions();
  const [showModal, setShowModal] = useState(false);
  const [showTicket, setShowTicket] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const [jobLabel, setJobLabel] = useState<string | null>(null);
  // Hover-State per JS damit's ohne Tailwind-Variant-Kompilierung funktioniert
  // (manche Tailwind-v4-Setups generieren `hover:scale-110` nicht zuverlaessig
  // bei selten-genutzten Elementen).
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [ticketHovered, setTicketHovered] = useState(false);
  // Sekundaerer Ticket-Trigger nur wenn User die Permission hat — Admins
  // passen via has_permission automatisch durch.
  const canTicket = can("tickets:create");
  // Desktop-Skip: das Widget ist per md:hidden nur auf Mobile sichtbar.
  // Trotzdem lief die Komponente auf Desktop komplett durch (Job-Label-
  // Query, Timer) — verschwendete Ressourcen. matchMedia (md-Breakpoint
  // 768px) filtert das aus. SSR-safe via lazy-Init.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : true
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  const supabase = createClient();

  // Live-Timer: 1s-Tick wenn eingestempelt UND mobile (Desktop rendert nichts).
  useEffect(() => {
    if (!active || !isMobile) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [active, isMobile]);

  // Job-Label nachladen wenn der active-Eintrag ein job_id hat —
  // wird in der Pille als "INT-1234 · Titel" angezeigt. Nur auf Mobile
  // (Desktop nutzt SidebarStempel und laedt sein Label separat).
  useEffect(() => {
    let cancelled = false;
    if (!active?.job_id || !isMobile) {
      setJobLabel(null);
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase
          .from("jobs")
          .select("job_number, title")
          .eq("id", active.job_id)
          .maybeSingle();
        if (error) throw error;
        if (!cancelled && data) {
          setJobLabel(`INT-${data.job_number} · ${data.title}`);
        }
      } catch {
        // Silent-Fallback — die Pille zeigt "Auftrag laden…" (aus dem
        // Render-Branch weiter unten). Kein Toast, das Widget ist Ambient.
        if (!cancelled) setJobLabel(null);
      }
    })();
    return () => { cancelled = true; };
  }, [active?.job_id, supabase, isMobile]);

  if (loading) return null;
  // Early-Return auf Desktop: spart DOM-Nodes, Timer und Job-Label-Fetch.
  // SidebarStempel uebernimmt dort das Stempel-UI.
  if (!isMobile) return null;

  async function handleStop() {
    const res = await clockOut();
    if (res.success) toast.success("Ausgestempelt");
    else toast.error(res.error || "Ausstempeln fehlgeschlagen");
    setExpanded(false);
  }

  return (
    <>
      {/* Volle-Breite-Stempel-Bar NUR auf Mobile (md:hidden), direkt ueber
          der MobileNav (die ist 80px hoch + safe-area). Optisch gleich wie
          die Sidebar-Stempel-Pille auf Desktop (gleiche Teal-Farbe + 2px
          Border + tinted bg). Auf Desktop bleibt der Sidebar-Stempel. */}
      <div className="md:hidden fixed left-3 right-3 z-40" style={{ bottom: "calc(env(safe-area-inset-bottom) + 80px + 8px)" }}>
        {active ? (
          <div className="space-y-2">
            {/* Expand-Card mit Details — aufklappbar oberhalb der Bar */}
            {expanded && (
              <div
                className="bg-card rounded-xl p-3 shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200"
                style={{ border: "1px solid rgba(20,184,166,0.4)" }}
              >
                <div className="flex items-start gap-2">
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                      active.job_id
                        ? "bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-400"
                        : "bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {active.job_id ? <Briefcase className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Eingestempelt</p>
                    <p className="text-sm font-medium truncate">
                      {active.job_id ? (jobLabel ?? "Auftrag laden…") : "Andere Arbeit"}
                    </p>
                    {active.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{active.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      Seit {new Date(active.clock_in).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
                {/* Modus-Wechsel-Chips waehrend laufender Stempelung —
                    nur wenn Location > 1 Tier hat. Klick startet neue
                    Stempelung mit anderem Tier (nach vorheriger Schliessung). */}
                <RateTierLiveSwitcher jobId={active.job_id} />
                <div className="flex gap-2 mt-3">
                  <Link
                    href="/stempelzeiten"
                    onClick={() => setExpanded(false)}
                    className="kasten kasten-muted flex-1 text-center"
                  >
                    Verlauf
                  </Link>
                  <button type="button" onClick={handleStop} className="kasten kasten-red flex-1">
                    <Square className="h-3.5 w-3.5" fill="currentColor" />
                    Ausstempeln
                  </button>
                </div>
              </div>
            )}
            {/* Volle-Breite-Bar — Live-Timer + Job/Beschreibung links, Chevron
                rechts. Klick toggelt expand. Sekundaerer Ticket-Button
                (Stempel-Aenderung) sitzt in der gleichen Zeile rechts. */}
            <div className="flex items-stretch gap-2">
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => { setHovered(false); setPressed(false); }}
              onMouseDown={() => setPressed(true)}
              onMouseUp={() => setPressed(false)}
              // Bg = solides Card-Token + teal-Tint mit hoeherer Alpha damit
              // Content darunter sauber verdeckt wird. Vorher rgba(...,0.14)
              // war zu transparent — Karten unter der Bar schienen durch.
              className="flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5 rounded-xl text-teal-700 dark:text-teal-300 bg-card"
              style={{
                transform: pressed ? "scale(0.99)" : hovered ? "scale(1.01)" : "scale(1)",
                transition: "transform 180ms cubic-bezier(0.4,0,0.2,1), box-shadow 200ms, background-color 200ms",
                backgroundImage: `linear-gradient(rgba(20,184,166,${hovered ? 0.28 : 0.18}), rgba(20,184,166,${hovered ? 0.28 : 0.18}))`,
                border: "2px solid var(--stempel-color, #14b8a6)",
                boxShadow: hovered ? "0 8px 20px -6px rgba(20,184,166,0.30)" : "0 3px 10px -3px rgba(20,184,166,0.18)",
              }}
              aria-label={expanded ? "Stempel-Details schliessen" : "Stempel-Details öffnen"}
            >
              <span className="relative flex shrink-0">
                <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full opacity-50" style={{ backgroundColor: "rgb(20,184,166)" }} />
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: "rgb(20,184,166)" }} />
              </span>
              <span className="font-mono text-sm font-semibold tabular-nums shrink-0">
                {formatStempelDuration(active.clock_in, now)}
              </span>
              <span className="text-xs opacity-75 truncate flex-1 text-left">
                {active.job_id ? (jobLabel ?? "Auftrag laden…") : (active.description || "Andere Arbeit")}
              </span>
              <ChevronUp className={`h-4 w-4 transition-transform shrink-0 ${expanded ? "rotate-180" : ""}`} />
            </button>
            {canTicket && (
              <button
                type="button"
                onClick={() => setShowTicket(true)}
                onMouseEnter={() => setTicketHovered(true)}
                onMouseLeave={() => setTicketHovered(false)}
                aria-label="Stempel-Änderung anfragen"
                data-tooltip="Stempel-Änderung anfragen"
                className="shrink-0 w-11 flex items-center justify-center rounded-xl bg-card"
                style={{
                  transition: "background-color 180ms, color 180ms, border-color 180ms",
                  border: `2px solid ${ticketHovered ? "var(--stempel-color, #14b8a6)" : "rgba(20,184,166,0.45)"}`,
                  backgroundImage: `linear-gradient(rgba(20,184,166,${ticketHovered ? 0.22 : 0.10}), rgba(20,184,166,${ticketHovered ? 0.22 : 0.10}))`,
                  color: ticketHovered ? "rgb(15,118,110)" : "rgb(20,184,166)",
                }}
              >
                <Ticket className="h-4 w-4" />
              </button>
            )}
            </div>
          </div>
        ) : (
          <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={() => setShowModal(true)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => { setHovered(false); setPressed(false); }}
            onMouseDown={() => setPressed(true)}
            onMouseUp={() => setPressed(false)}
            className="flex-1 min-w-0 flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl text-teal-700 dark:text-teal-300 bg-card"
            style={{
              transform: pressed ? "scale(0.99)" : hovered ? "scale(1.01)" : "scale(1)",
              transition: "transform 180ms cubic-bezier(0.4,0,0.2,1), background-color 200ms",
              backgroundImage: `linear-gradient(rgba(20,184,166,${hovered ? 0.28 : 0.18}), rgba(20,184,166,${hovered ? 0.28 : 0.18}))`,
              border: "2px solid var(--stempel-color, #14b8a6)",
              boxShadow: "0 3px 10px -3px rgba(20,184,166,0.18)",
            }}
            aria-label="Einstempeln"
          >
            <Clock className="h-4 w-4" />
            <span className="text-sm font-semibold">Einstempeln</span>
          </button>
          {canTicket && (
            <button
              type="button"
              onClick={() => setShowTicket(true)}
              onMouseEnter={() => setTicketHovered(true)}
              onMouseLeave={() => setTicketHovered(false)}
              aria-label="Stempel-Änderung anfragen"
              data-tooltip="Stempel-Änderung anfragen"
              className="shrink-0 w-11 flex items-center justify-center rounded-xl bg-card"
              style={{
                transition: "background-color 180ms, color 180ms, border-color 180ms",
                border: `2px solid ${ticketHovered ? "var(--stempel-color, #14b8a6)" : "rgba(20,184,166,0.45)"}`,
                backgroundImage: `linear-gradient(rgba(20,184,166,${ticketHovered ? 0.22 : 0.10}), rgba(20,184,166,${ticketHovered ? 0.22 : 0.10}))`,
                color: ticketHovered ? "rgb(15,118,110)" : "rgb(20,184,166)",
              }}
            >
              <Ticket className="h-4 w-4" />
            </button>
          )}
          </div>
        )}
      </div>

      <StempelModal open={showModal} onClose={() => setShowModal(false)} />
      <NewTicketModal
        open={showTicket}
        onClose={() => setShowTicket(false)}
        onCreated={() => {
          setShowTicket(false);
          toast.success("Ticket erstellt — Admin wurde benachrichtigt");
        }}
        initialType="stempel_aenderung"
      />
    </>
  );
}
