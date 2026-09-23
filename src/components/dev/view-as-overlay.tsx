"use client";

/**
 * ViewAsOverlay — dezentes, schwebendes Overlay fuer den Developer-Mode.
 *
 * Design-Prinzip: SCHLICHT und PROFESSIONELL. Kein knalliger Banner ueber
 * dem Viewport (das haben wir frueher gehabt — sah nach 'in Development'
 * aus). Stattdessen:
 *   - Nicht impersoniert: kleiner Icon-Button unten rechts, monochrom.
 *   - Impersoniert:       Eyebrow-Chip oben rechts + Icon-Button bekommt
 *                         Akzent-Kontur (aktiv-Zustand). Kein Vollbreiten-
 *                         Warnstreifen mehr.
 *   - Beim Oeffnen:       kompaktes Panel unten rechts. Suchfeld im Header,
 *                         Kandidaten-Liste gruppiert nach Team / Partner.
 *
 * Sichtbar nur wenn:
 *   1) Eingeloggter (ECHTER) User ist Admin
 *   2) profiles.developer_mode_enabled === true
 *
 * Layout-agnostisch — laedt sein Admin-Profile selbst statt via
 * usePermissions, damit es auch im /partner-Portal funktioniert (das
 * keinen PermissionsProvider hat).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, ChevronDown, LogOut, Loader2, Search, Power, Lock, Pencil, Radio } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LiveBroadcastSender } from "@/components/dev/live-broadcast-sender";
import { MobilePreviewFrame } from "@/components/dev/mobile-preview-frame";
import { useOnlinePresence } from "@/lib/use-online-presence";
import { istIntern } from "@/lib/roles";
import { portalForPath, portalForRole } from "@/lib/portals";

interface Candidate {
  id: string;
  full_name: string;
  role: string;
}
interface CurrentState {
  active: boolean;
  target_user_id?: string;
  target?: { id: string; full_name: string; role: string } | null;
  write_enabled?: boolean;
}

export function ViewAsOverlay() {
  const supabase = createClient();
  const presenceSet = useOnlinePresence();
  const [realUserRole, setRealUserRole] = useState<string | null>(null);
  const [realUserId, setRealUserId] = useState<string | null>(null);
  const [realUserName, setRealUserName] = useState<string>("Admin");
  const [ready, setReady] = useState(false);
  // Live-Uebertragung: rein clientseitiger State. Wird beim Wechseln des
  // impersonierten Users / Stop-Impersonate zurueckgesetzt.
  const [liveActive, setLiveActive] = useState(false);
  // Mobile-Preview: rendert die aktuelle Seite in einem iframe mit
  // Handy-Viewport-Groesse. Media-Queries greifen echt (kein Fake-Scale).
  const [mobilePreview, setMobilePreview] = useState(false);
  const [isEmbed, setIsEmbed] = useState(false);
  const [devModeEnabled, setDevModeEnabled] = useState<boolean | null>(null);
  const [current, setCurrent] = useState<CurrentState | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  // Hold-to-activate fuer den Write-Modus: 5 Sekunden Halten statt Confirm.
  const HOLD_MS = 5000;
  const [holdProgress, setHoldProgress] = useState(0); // 0..1
  const holdStartRef = useRef<number | null>(null);
  const holdRafRef = useRef<number | null>(null);
  const holdDoneRef = useRef(false);
  const isAdmin = realUserRole === "admin";

  const cancelHold = useCallback(() => {
    if (holdRafRef.current !== null) {
      cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = null;
    }
    holdStartRef.current = null;
    holdDoneRef.current = false;
    setHoldProgress(0);
  }, []);

  // Cleanup beim Unmount — kein rAF-Leak.
  useEffect(() => {
    return () => {
      if (holdRafRef.current !== null) cancelAnimationFrame(holdRafRef.current);
    };
  }, []);

  const startHold = useCallback(() => {
    if (holdStartRef.current !== null) return; // schon aktiv
    holdDoneRef.current = false;
    holdStartRef.current = performance.now();
    const tick = (now: number) => {
      const start = holdStartRef.current;
      if (start === null) return; // gecancelt
      const p = Math.min(1, (now - start) / HOLD_MS);
      setHoldProgress(p);
      if (p >= 1) {
        holdDoneRef.current = true;
        holdStartRef.current = null;
        holdRafRef.current = null;
        setHoldProgress(0);
        void toggleWriteMode(true);
        return;
      }
      holdRafRef.current = requestAnimationFrame(tick);
    };
    holdRafRef.current = requestAnimationFrame(tick);
  }, []);

  // Wenn wir im iframe laufen (Mobile-Preview embed), NICHT rendern — sonst
  // gaebe es doppelte Overlays und Rekursions-Verwirrung.
  useEffect(() => {
    if (typeof window !== "undefined" && window.self !== window.top) {
      setIsEmbed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) { setReady(true); return; }
      setRealUserId(user.id);
      const { data } = await supabase
        .from("profiles")
        .select("role, developer_mode_enabled, full_name")
        .eq("id", user.id)
        .maybeSingle();
      if (cancelled) return;
      setRealUserRole((data?.role as string) ?? null);
      setRealUserName((data?.full_name as string) ?? "Admin");
      setDevModeEnabled(Boolean(data?.developer_mode_enabled));
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [supabase]);

  const refresh = useCallback(async () => {
    if (!realUserId) return;
    const { data } = await supabase
      .from("profiles")
      .select("developer_mode_enabled, role")
      .eq("id", realUserId)
      .maybeSingle();
    setRealUserRole((data?.role as string) ?? realUserRole);
    setDevModeEnabled(Boolean(data?.developer_mode_enabled));
    if (data?.developer_mode_enabled) {
      const r = await fetch("/api/dev/impersonate");
      if (r.ok) setCurrent(await r.json());
    } else {
      setCurrent({ active: false });
    }
  }, [realUserId, realUserRole, supabase]);

  useEffect(() => {
    function onChange() { void refresh(); }
    window.addEventListener("developer-mode-changed", onChange);
    return () => window.removeEventListener("developer-mode-changed", onChange);
  }, [refresh]);

  useEffect(() => {
    if (ready && isAdmin && devModeEnabled) {
      (async () => {
        const r = await fetch("/api/dev/impersonate");
        if (r.ok) setCurrent(await r.json());
      })();
    }
  }, [ready, isAdmin, devModeEnabled]);

  useEffect(() => {
    if (!open || !devModeEnabled) return;
    (async () => {
      const r = await fetch("/api/dev/impersonate/candidates");
      if (r.ok) {
        const json = (await r.json()) as { users?: Candidate[] };
        setCandidates(json.users ?? []);
      }
    })();
  }, [open, devModeEnabled]);

  // Kandidaten nach Team / Partner gruppieren — statt einer Filter-Chip-Reihe.
  const { teamList, partnerList } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (u: Candidate) =>
      !q || u.full_name.toLowerCase().includes(q) || u.role.toLowerCase().includes(q);
    return {
      teamList: candidates.filter((u) => istIntern(u.role) && match(u)),
      partnerList: candidates.filter((u) => !istIntern(u.role) && match(u)),
    };
  }, [candidates, search]);

  async function startImpersonation(targetId: string) {
    cancelHold(); // Reviewer C1: rAF weiterlaufen zu lassen waere Race
    setLoading(true);
    setLiveActive(false); // Wechsel = Live neu bewusst starten
    try {
      const r = await fetch("/api/dev/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_user_id: targetId }),
      });
      const json = await r.json();
      if (!json.success) throw new Error(json.error ?? "Fehler");
      // Registry-Dispatch: Portal-User (Partner/Lieferant/…) → in DESSEN
      // Portal springen; interner User → aus jedem Portal zurueck ins
      // Firmen-Dashboard. Vorher wurde nur 'partner' geprueft — die
      // Impersonation eines Lieferanten blieb faelschlich in der (app)-
      // Shell haengen statt ins /lieferant-Portal zu wechseln (Bugfix).
      const targetPortal = portalForRole(json.target?.role as string | undefined);
      const currentPortal = portalForPath(window.location.pathname);
      if (targetPortal && currentPortal?.slug !== targetPortal.slug) {
        window.location.href = targetPortal.homePath;
        return;
      }
      if (!targetPortal && currentPortal) {
        window.location.href = "/dashboard";
        return;
      }
      window.location.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fehler beim Wechsel");
      setLoading(false);
    }
  }

  async function stopImpersonation() {
    cancelHold(); // Reviewer C1: mid-Hold-Complete rennt sonst gegen DELETE
    setLoading(true);
    try {
      await fetch("/api/dev/impersonate", { method: "DELETE" });
      // In JEDEM Portal (Partner/Lieferant/…): zurueck ins Firmen-Dashboard.
      if (portalForPath(window.location.pathname)) {
        window.location.href = "/dashboard";
        return;
      }
      window.location.reload();
    } catch {
      toast.error("Beenden fehlgeschlagen");
      setLoading(false);
    }
  }

  /** Write-Modus fuer die aktive Impersonation ein-/ausschalten. Das
   *  Einschalten erfolgt bewusst NUR ueber den 5s-Hold-Button unten, nicht
   *  ueber einen normalen Klick — daher hier keine zusaetzliche Bestaetigung.
   *  Das Deaktivieren bleibt ein Klick. */
  async function toggleWriteMode(next: boolean) {
    setLoading(true);
    try {
      const r = await fetch("/api/dev/impersonate/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const json = (await r.json()) as { success?: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? "Fehler");
      setCurrent((c) => (c ? { ...c, write_enabled: next } : c));
      toast.success(next ? "Bearbeitung aktiviert" : "Nur-Lesen-Modus");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      setLoading(false);
    }
  }

  /** Developer Mode komplett ausschalten — auch von hier aus, damit der
   *  Admin nicht zurueck in die Team-Einstellungen navigieren muss. Server
   *  loescht dabei auch das Impersonation-Cookie (siehe /api/dev/toggle).
   *  Danach: reload damit Overlay + evtl. Portal-Zustand sauber sind. */
  async function disableDevMode() {
    cancelHold(); // Reviewer C1: mid-Hold gegen DevMode-Off Race
    setLoading(true);
    try {
      const res = await fetch("/api/dev/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? "Fehler");
      // In JEDEM Portal (Partner/Lieferant/…): zurueck ins Firmen-Dashboard.
      if (portalForPath(window.location.pathname)) {
        window.location.href = "/dashboard";
        return;
      }
      window.location.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Fehler");
      setLoading(false);
    }
  }

  if (isEmbed) return null;
  if (!ready || !isAdmin || !devModeEnabled) return null;

  const active = current?.active === true && current?.target;

  return (
    <>
      {/* Statuszeile oben rechts — schlanker Chip, kein Full-Width-Banner.
          Nur sichtbar wenn wirklich impersoniert wird. */}
      {active && (
        <div
          style={{
            position: "fixed",
            top: 10,
            right: 14,
            zIndex: 1400,
            pointerEvents: "none",
          }}
        >
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-[11px] font-semibold uppercase tracking-wider shadow-lg"
            style={{
              // Semi-transparent Kasten (rounded-xl matcht kasten-System
              // aus globals.css). Backdrop-blur damit die Farbe des Content
              // dahinter subtil durchscheint.
              background: current!.write_enabled
                ? "color-mix(in oklab, #dc2626 22%, transparent)"
                : "color-mix(in oklab, var(--accent) 18%, transparent)",
              color: current!.write_enabled ? "#dc2626" : "var(--accent)",
              border: `1px solid ${current!.write_enabled
                ? "color-mix(in oklab, #dc2626 60%, transparent)"
                : "color-mix(in oklab, var(--accent) 50%, transparent)"}`,
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
            }}
          >
            {current!.write_enabled ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            <span>
              als {current!.target!.full_name}
              {(() => {
                // Portal-Label aus der Registry ("· Partner" / "· Lieferant").
                const p = portalForRole(current!.target!.role);
                return p ? ` · ${p.label}` : "";
              })()}
              {current!.write_enabled ? " · Bearbeitung" : " · nur lesen"}
            </span>
            {liveActive && (
              <span
                className="inline-flex items-center gap-1 ml-1 pl-1.5 border-l"
                style={{ borderColor: "currentColor" }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{
                    background: "#dc2626",
                    animation: "view-as-live-blink 1s ease-in-out infinite",
                    boxShadow: "0 0 6px #dc2626",
                  }}
                />
                LIVE
              </span>
            )}
          </div>
        </div>
      )}
      {/* Blinken-Animation fuer den Live-Punkt (kein zusaetzliches CSS-File). */}
      <style>{`
        @keyframes view-as-live-blink {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>

      {/* Floating Panel unten rechts. Zu = kleiner Icon-Button (kein Text
          im idle-Zustand, damit es dezent bleibt); auf = Panel. */}
      <div
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 1300,
        }}
      >
        {open ? (
          <div
            className="rounded-xl shadow-xl overflow-hidden flex flex-col"
            style={{
              width: 320,
              maxHeight: "min(72vh, 540px)",
              background: "var(--card)",
              border: "1px solid var(--border)",
            }}
          >
            {/* Header */}
            <div
              className="flex items-center gap-2 px-3 py-2.5 border-b"
              style={{ borderColor: "var(--border)" }}
            >
              <span
                className="inline-flex items-center justify-center w-6 h-6 rounded-md shrink-0"
                style={{
                  background: active
                    ? "color-mix(in oklab, var(--accent) 15%, transparent)"
                    : "color-mix(in oklab, var(--foreground) 8%, transparent)",
                  color: active ? "var(--accent)" : "var(--muted-foreground)",
                }}
              >
                <Eye className="h-3.5 w-3.5" />
              </span>
              <span className="text-xs font-semibold flex-1 min-w-0">
                View-As
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Schliessen"
                className="p-1 rounded hover:bg-muted/60 text-muted-foreground"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Viewport-Toggle: Desktop | Mobile. Immer sichtbar — funktioniert
                auch ohne Impersonation (Admin will z.B. eigene Seite mobil
                testen). */}
            <div
              className="px-3 py-2 border-b flex items-center gap-2"
              style={{ borderColor: "var(--border)" }}
            >
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
                Ansicht
              </span>
              <div
                className="flex items-center rounded-md border overflow-hidden ml-auto"
                style={{ borderColor: "var(--border)" }}
                role="group"
                aria-label="Viewport"
              >
                <button
                  type="button"
                  onClick={() => setMobilePreview(false)}
                  aria-pressed={!mobilePreview}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold transition-colors"
                  style={{
                    background: !mobilePreview
                      ? "color-mix(in oklab, var(--foreground) 10%, transparent)"
                      : "transparent",
                    color: !mobilePreview ? "var(--foreground)" : "var(--muted-foreground)",
                    cursor: "pointer",
                    border: "none",
                  }}
                >
                  Desktop
                </button>
                <button
                  type="button"
                  onClick={() => setMobilePreview(true)}
                  aria-pressed={mobilePreview}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold transition-colors"
                  style={{
                    background: mobilePreview
                      ? "color-mix(in oklab, var(--accent) 12%, transparent)"
                      : "transparent",
                    color: mobilePreview ? "var(--accent)" : "var(--muted-foreground)",
                    cursor: "pointer",
                    border: "none",
                  }}
                >
                  Mobil
                </button>
              </div>
            </div>

            {/* Current-Status */}
            {active ? (
              <div
                className="border-b"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="px-3 pt-2.5 pb-2 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Aktuell simuliert
                    </p>
                    <p className="text-sm font-medium truncate">
                      {current!.target!.full_name}
                      <span className="text-muted-foreground font-normal ml-1.5">
                        · {current!.target!.role}
                      </span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={stopImpersonation}
                    disabled={loading}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border transition-colors"
                    style={{
                      borderColor: "var(--border)",
                      color: "var(--foreground)",
                      background: "transparent",
                      cursor: loading ? "wait" : "pointer",
                    }}
                  >
                    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
                    Beenden
                  </button>
                </div>
                {/* Read-Only vs Bearbeitung — expliziter Toggle. Default:
                    read-only. Aktivieren braucht 5s HALTEN (kein Confirm-
                    Dialog); Deaktivieren ist ein normaler Klick. */}
                <div className="px-3 pb-2 space-y-1.5">
                  {current!.write_enabled ? (
                    <button
                      type="button"
                      onClick={() => toggleWriteMode(false)}
                      disabled={loading}
                      className="w-full inline-flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition-colors"
                      style={{
                        borderColor: "color-mix(in oklab, #dc2626 55%, transparent)",
                        background: "color-mix(in oklab, #dc2626 10%, transparent)",
                        color: "#dc2626",
                        cursor: loading ? "wait" : "pointer",
                      }}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Pencil className="h-3 w-3" />
                        Bearbeitung aktiv
                      </span>
                      <span className="text-[10px] opacity-75">sperren</span>
                    </button>
                  ) : (
                    (() => {
                      const holding = holdProgress > 0;
                      const pct = Math.round(holdProgress * 100);
                      const disabled = loading;
                      return (
                        <button
                          type="button"
                          disabled={disabled}
                          onPointerDown={(e) => {
                            if (disabled) return;
                            // Pointer waehrend Hold behalten, damit
                            // Leave/Up sauber feuern.
                            e.currentTarget.setPointerCapture?.(e.pointerId);
                            startHold();
                          }}
                          onPointerUp={cancelHold}
                          onPointerLeave={cancelHold}
                          onPointerCancel={cancelHold}
                          onTouchStart={() => { if (!disabled) startHold(); }}
                          onTouchEnd={cancelHold}
                          onTouchCancel={cancelHold}
                          onKeyDown={(e) => {
                            if (disabled) return;
                            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                              e.preventDefault();
                              startHold();
                            }
                          }}
                          onKeyUp={(e) => {
                            if (e.key === " " || e.key === "Enter") cancelHold();
                          }}
                          onBlur={cancelHold}
                          className="relative w-full overflow-hidden inline-flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md border text-[11px] font-medium select-none"
                          style={{
                            borderColor: holding
                              ? "color-mix(in oklab, #dc2626 55%, transparent)"
                              : "var(--border)",
                            background: "color-mix(in oklab, var(--foreground) 3%, transparent)",
                            color: holding ? "#dc2626" : "var(--foreground)",
                            cursor: disabled ? "wait" : "pointer",
                            touchAction: "none",
                            WebkitUserSelect: "none",
                            userSelect: "none",
                          }}
                        >
                          {/* Fill von links nach rechts. Zeigt Fortschritt. */}
                          <span
                            aria-hidden
                            style={{
                              position: "absolute",
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: `${pct}%`,
                              background: "color-mix(in oklab, #dc2626 22%, transparent)",
                              transition: holding ? "none" : "width 160ms ease-out",
                              pointerEvents: "none",
                            }}
                          />
                          <span className="relative inline-flex items-center gap-1.5">
                            <Lock className="h-3 w-3" />
                            {holding ? "Halten zum Aktivieren…" : "Nur Lesen"}
                          </span>
                          <span className="relative text-[10px] opacity-75">
                            {holding ? `${pct}%` : "5s halten"}
                          </span>
                        </button>
                      );
                    })()
                  )}
                  {/* Live-Uebertragung — der User sieht in seinem Browser
                      Admins Cursor / Klicks / Eingaben, kann selbst nichts
                      tun (Input-Lock). Broadcast via Supabase Realtime. */}
                  <button
                    type="button"
                    onClick={() => setLiveActive((v) => !v)}
                    className="w-full inline-flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition-colors"
                    style={{
                      borderColor: liveActive
                        ? "color-mix(in oklab, #dc2626 55%, transparent)"
                        : "var(--border)",
                      background: liveActive
                        ? "color-mix(in oklab, #dc2626 10%, transparent)"
                        : "color-mix(in oklab, var(--foreground) 3%, transparent)",
                      color: liveActive ? "#dc2626" : "var(--foreground)",
                      cursor: "pointer",
                    }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Radio className={`h-3 w-3 ${liveActive ? "animate-pulse" : ""}`} />
                      {liveActive ? "Live-Übertragung läuft" : "Live-Übertragung"}
                    </span>
                    <span className="text-[10px] opacity-75">
                      {liveActive ? "beenden" : "starten"}
                    </span>
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="px-3 py-2 border-b text-[11px] text-muted-foreground"
                style={{ borderColor: "var(--border)" }}
              >
                Wähle einen Mitarbeiter zum Simulieren.
              </div>
            )}

            {/* Suche */}
            <div
              className="px-3 py-2 border-b"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="relative">
                <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Suchen…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md bg-transparent focus:outline-none focus:ring-1"
                  style={{
                    border: "1px solid var(--border)",
                  }}
                />
              </div>
              {/* Presence-Status: "N online" = alle User im app-presence
                  channel MINUS uns selbst. Grüner Punkt in derselben
                  view-as-live-blink-Animation wie im Live-Chip oben. */}
              {(() => {
                const othersOnline = Math.max(
                  0,
                  presenceSet.size - (realUserId && presenceSet.has(realUserId) ? 1 : 0),
                );
                return (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{
                        background: "#10b981",
                        boxShadow: "0 0 6px #10b981",
                        animation: "view-as-live-blink 1s ease-in-out infinite",
                      }}
                      aria-hidden
                    />
                    <span>{othersOnline} online</span>
                  </div>
                );
              })()}
            </div>

            {/* Kandidaten — gruppiert nach Team / Partner */}
            <div className="overflow-y-auto flex-1">
              {teamList.length === 0 && partnerList.length === 0 ? (
                <p className="text-[11px] text-muted-foreground text-center py-8">
                  Keine Einträge.
                </p>
              ) : (
                <div className="py-1.5">
                  {teamList.length > 0 && (
                    <CandidateGroup
                      label="Team"
                      users={teamList}
                      currentId={current?.target_user_id ?? null}
                      loading={loading}
                      onPick={startImpersonation}
                      presenceSet={presenceSet}
                    />
                  )}
                  {partnerList.length > 0 && (
                    <CandidateGroup
                      label="Partner"
                      users={partnerList}
                      currentId={current?.target_user_id ?? null}
                      loading={loading}
                      onPick={startImpersonation}
                      presenceSet={presenceSet}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Footer — Developer Mode direkt vom Panel aus komplett
                ausschalten. Kein Umweg ueber die Team-Einstellungen. */}
            <div
              className="px-3 py-2 border-t"
              style={{ borderColor: "var(--border)" }}
            >
              <button
                type="button"
                onClick={disableDevMode}
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-medium rounded-md transition-colors"
                style={{
                  color: "#dc2626",
                  background: "transparent",
                  cursor: loading ? "wait" : "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "color-mix(in oklab, #dc2626 10%, transparent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
                Developer Mode ausschalten
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="View-As öffnen"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl shadow-lg transition-all hover:shadow-xl"
            style={{
              // Kasten-Form (rounded-xl), semi-transparent mit backdrop-blur.
              // Farbtinte richtet sich nach Zustand: live > active > idle.
              background: liveActive
                ? "color-mix(in oklab, #dc2626 20%, transparent)"
                : active
                  ? "color-mix(in oklab, var(--accent) 16%, transparent)"
                  : "color-mix(in oklab, var(--card) 88%, transparent)",
              border: `1px solid ${liveActive
                ? "color-mix(in oklab, #dc2626 60%, transparent)"
                : active
                  ? "color-mix(in oklab, var(--accent) 50%, transparent)"
                  : "var(--border)"}`,
              color: liveActive ? "#dc2626" : active ? "var(--accent)" : "var(--foreground)",
              backdropFilter: "blur(10px)",
              WebkitBackdropFilter: "blur(10px)",
              // Live: zusaetzlicher Halo-Ring als Alarm-Signal.
              boxShadow: liveActive
                ? "0 0 0 3px color-mix(in oklab, #dc2626 25%, transparent), 0 6px 16px rgba(0,0,0,0.2)"
                : undefined,
            }}
          >
            {liveActive ? (
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{
                  background: "#dc2626",
                  animation: "view-as-live-blink 1s ease-in-out infinite",
                  boxShadow: "0 0 6px #dc2626",
                }}
                aria-label="Live"
              />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            <span className="text-xs font-semibold">
              {active ? current!.target!.full_name.split(" ")[0] : "View-As"}
              {liveActive && " · LIVE"}
            </span>
          </button>
        )}
      </div>

      {/* Sender — nur mounted wenn Impersonation + Live-Mode aktiv.
          Broadcast an live:<target_user_id>. */}
      <LiveBroadcastSender
        targetUserId={active && liveActive ? (current!.target_user_id ?? null) : null}
        liveActive={liveActive}
        adminName={realUserName}
      />

      {/* Mobile-Preview — Fullscreen-Overlay mit iframe im Handy-Bezel. */}
      {mobilePreview && <MobilePreviewFrame onClose={() => setMobilePreview(false)} />}
    </>
  );
}

function CandidateGroup({
  label,
  users,
  currentId,
  loading,
  onPick,
  presenceSet,
}: {
  label: string;
  users: Candidate[];
  currentId: string | null;
  loading: boolean;
  onPick: (id: string) => void;
  presenceSet: Set<string>;
}) {
  return (
    <div className="pb-1">
      <p className="px-3 py-1 text-[9px] uppercase tracking-wider font-semibold text-muted-foreground/70">
        {label} · {users.length}
      </p>
      <ul>
        {users.map((u) => {
          const isCurrent = currentId === u.id;
          const isOnline = presenceSet.has(u.id);
          return (
            <li key={u.id}>
              <button
                type="button"
                disabled={loading || isCurrent}
                onClick={() => onPick(u.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors"
                style={{
                  background: isCurrent
                    ? "color-mix(in oklab, var(--accent) 10%, transparent)"
                    : "transparent",
                  cursor: loading ? "wait" : isCurrent ? "default" : "pointer",
                }}
                onMouseEnter={(e) => {
                  if (!isCurrent && !loading) {
                    e.currentTarget.style.background =
                      "color-mix(in oklab, var(--foreground) 5%, transparent)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isCurrent) e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-semibold shrink-0"
                  style={{
                    background: "color-mix(in oklab, var(--foreground) 10%, transparent)",
                    color: "var(--foreground)",
                  }}
                >
                  {initials(u.full_name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate leading-tight flex items-center gap-1.5">
                    <span className="truncate">{u.full_name}</span>
                    {isOnline && (
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                        style={{
                          background: "#10b981",
                          boxShadow: "0 0 6px #10b981",
                          animation: "view-as-live-blink 1s ease-in-out infinite",
                        }}
                        aria-label="Online"
                        data-tooltip="Online"
                      />
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate leading-tight mt-0.5">{u.role}</p>
                </div>
                {isCurrent && (
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-accent shrink-0">aktiv</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
