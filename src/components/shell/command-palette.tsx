"use client";

// Cmd-K Command-Palette.
//
// Global via ⌘K / Ctrl+K aufrufbar (Listener am App-Layout registriert).
// Modal ueber der ganzen App, Fokus im Suchfeld, tippen zeigt Ergebnisse
// gruppiert nach Typ, Enter navigiert.
//
// Tastatur:
//   ⌘K / Ctrl+K → oeffnen
//   Esc          → schliessen
//   ↑ / ↓       → Auswahl bewegen
//   Enter        → aktive Auswahl oeffnen
//
// Datenquelle: /api/search?q=... (RLS aktiv). Debounced 250ms.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  Search,
  ClipboardList,
  TrendingUp,
  Users,
  MapPin,
  Home,
  TicketCheck,
  CheckSquare,
  User,
  Loader2,
  Zap,
} from "lucide-react";
import type { SearchResult } from "@/app/api/search/route";
import { matchActions, type PaletteAction } from "./palette-actions";
import { usePermissions } from "@/lib/use-permissions";

/** Eintrag in der flachen Tastatur-Navigationsliste — Aktion oder
 *  Server-Suchtreffer. Beide navigieren via href. */
type PaletteItem = PaletteAction | SearchResult;
function isAction(item: PaletteItem): item is PaletteAction {
  return "keywords" in item;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const TYPE_META: Record<
  SearchResult["type"],
  { label: string; icon: React.ComponentType<{ className?: string }>; order: number }
> = {
  auftrag:        { label: "Aufträge",         icon: ClipboardList, order: 1 },
  lead:           { label: "Leads",            icon: TrendingUp,    order: 3 },
  kunde:          { label: "Kunden",           icon: Users,         order: 4 },
  standort:       { label: "Standorte",        icon: MapPin,        order: 5 },
  raum:           { label: "Räume",            icon: Home,          order: 6 },
  ticket:         { label: "Tickets",          icon: TicketCheck,   order: 7 },
  todo:           { label: "Todos",            icon: CheckSquare,   order: 8 },
  mitarbeiter:    { label: "Mitarbeiter",      icon: User,          order: 9 },
};

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const { can, role } = usePermissions();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Race-Condition-Guard: schnelles Tippen loest mehrere Fetches aus.
  // Nur das Ergebnis des juengsten Requests wird uebernommen.
  const reqIdRef = useRef(0);

  // Reset beim OEffnen — vorheriger Query soll nicht stehenbleiben.
  useEffect(() => {
    if (open) {
      setQ("");
      setResults([]);
      setActiveIndex(0);
      // Kurzer Timeout damit Portal + Focus-Trap sich setzen konnten.
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Body-Scroll lock — analog Modal.tsx, damit Hintergrund nicht scrollt.
  useEffect(() => {
    if (!open) return;
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, [open]);

  // Debounced Search — 250ms nach dem letzten Tastendruck.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as { results?: SearchResult[] };
        if (myId !== reqIdRef.current) return; // stale
        setResults(json.results ?? []);
        setActiveIndex(0);
      } catch {
        if (myId !== reqIdRef.current) return;
        setResults([]);
      } finally {
        if (myId === reqIdRef.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  // Aktionen-Treffer: client-seitig, instant (kein Server-Roundtrip).
  // "krank" → Abwesenheit melden, "lohnerhoehung" → HR → Loehne, usw.
  const actions = useMemo(() => {
    const query = q.trim();
    if (query.length < 2) return [];
    return matchActions(query, can, role === "admin");
  }, [q, can, role]);

  // Ergebnisse fuer Rendering gruppieren. Reihenfolge fest via TYPE_META.order,
  // damit dieselbe Query immer dieselbe visuelle Anordnung ergibt.
  const grouped = useMemo(() => {
    const byType = new Map<SearchResult["type"], SearchResult[]>();
    for (const r of results) {
      const arr = byType.get(r.type) ?? [];
      arr.push(r);
      byType.set(r.type, arr);
    }
    return Array.from(byType.entries()).sort(
      (a, b) => TYPE_META[a[0]].order - TYPE_META[b[0]].order,
    );
  }, [results]);

  // Flache Liste in visueller Reihenfolge fuer Tastatur-Navigation —
  // Aktionen zuoberst (Direktziel schlaegt Datensatz-Treffer).
  const flat = useMemo<PaletteItem[]>(
    () => [...actions, ...grouped.flatMap(([, arr]) => arr)],
    [actions, grouped],
  );

  const go = useCallback(
    (r: PaletteItem) => {
      router.push(r.href);
      onClose();
    },
    [router, onClose],
  );

  // Tastatur-Handler auf Input — Pfeil hoch/runter + Enter + Esc.
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, flat.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = flat[activeIndex];
      if (r) go(r);
      return;
    }
  };

  // Aktive Zeile in den Viewport scrollen falls sie ausserhalb liegt.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-cmdk-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  // Global Escape-Handler: schliesst auch wenn Focus NICHT im Input ist
  // (User klickt daneben und drueckt Esc → sollte trotzdem zu).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* Backdrop rein visuell (Dim + Blur). Klick-zu-Schliessen macht der
          Panel-Container darueber — sonst faengt der Container die Klicks ab
          weil er inset-0 liegt und ueber dem Backdrop rendert. */}
      <div className="fixed inset-0 z-[1100] bg-black/60 backdrop-blur pointer-events-none" />
      <div
        className="fixed inset-0 z-[1110] flex items-start justify-center p-4 pt-[10vh]"
        onClick={onClose}
      >
        <div
          className="bg-card rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden border flex flex-col max-h-[70vh]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header = Suchfeld. Icon links, Loading rechts. */}
          <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Suchen — Aufträge, Kunden, Leads, Räume, Tickets…"
              className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground/60"
              aria-label="Suche"
            />
            {loading && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
            )}
          </div>

          {/* Ergebnis-Liste */}
          <div ref={listRef} className="overflow-y-auto flex-1 min-h-0">
            {q.trim().length < 2 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                Mindestens 2 Zeichen eingeben.
              </div>
            ) : !loading && flat.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                Keine Treffer für &laquo;{q}&raquo;.
              </div>
            ) : (
              <div className="py-2">
                {/* Aktionen — Direktnavigation ("krank" → Abwesenheit melden,
                    "lohnerhoehung" → HR → Loehne). Immer zuoberst. */}
                {actions.length > 0 && (
                  <div className="mb-2">
                    <div className="px-4 py-1 text-[10px] font-semibold tracking-wider uppercase text-muted-foreground/60">
                      Aktionen
                    </div>
                    {actions.map((a) => {
                      const idx = flat.indexOf(a);
                      const isActive = idx === activeIndex;
                      const Icon = a.icon;
                      return (
                        <button
                          key={`aktion-${a.id}`}
                          type="button"
                          data-cmdk-index={idx}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={() => go(a)}
                          className={
                            "w-full flex items-center gap-3 px-4 py-2 text-left transition-colors " +
                            (isActive ? "bg-muted/70" : "hover:bg-muted/40")
                          }
                        >
                          <div
                            className={
                              "flex items-center justify-center w-7 h-7 rounded-md shrink-0 " +
                              (isActive
                                ? "bg-red-500/20 text-red-500 dark:text-red-400"
                                : "bg-foreground/[0.06] text-foreground/60")
                            }
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate flex items-center gap-1.5">
                              {a.label}
                              <Zap className="h-3 w-3 text-muted-foreground/50" />
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {a.sublabel}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {grouped.map(([type, items]) => {
                  const meta = TYPE_META[type];
                  const Icon = meta.icon;
                  return (
                    <div key={type} className="mb-2 last:mb-0">
                      <div className="px-4 py-1 text-[10px] font-semibold tracking-wider uppercase text-muted-foreground/60">
                        {meta.label}
                      </div>
                      {items.map((r) => {
                        const idx = flat.indexOf(r);
                        const isActive = idx === activeIndex;
                        return (
                          <button
                            key={`${r.type}-${r.id}`}
                            type="button"
                            data-cmdk-index={idx}
                            onMouseEnter={() => setActiveIndex(idx)}
                            onClick={() => go(r)}
                            className={
                              "w-full flex items-center gap-3 px-4 py-2 text-left transition-colors " +
                              (isActive
                                ? "bg-muted/70"
                                : "hover:bg-muted/40")
                            }
                          >
                            <div
                              className={
                                "flex items-center justify-center w-7 h-7 rounded-md shrink-0 " +
                                (isActive
                                  ? "bg-red-500/20 text-red-500 dark:text-red-400"
                                  : "bg-foreground/[0.06] text-foreground/60")
                              }
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium truncate">
                                {r.label}
                              </div>
                              {r.sublabel && (
                                <div className="text-xs text-muted-foreground truncate">
                                  {r.sublabel}
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer-Legende bewusst entfernt (Leo 2026-09-02): "nicht so viel
              erklaeren". Esc/Pfeil/Enter sind Standard-Konvention. */}
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * Custom Window-Event Name — Trigger-Button und der App-Layout-Listener
 * kommunizieren darueber, damit der Button ohne Prop-Drilling
 * irgendwo im Tree sitzen kann.
 */
export const CMDK_OPEN_EVENT = "cmdk:open";

/**
 * Kleiner Trigger-Button fuer den Header/Sidebar — zeigt „Suche… ⌘K"
 * damit die Palette entdeckbar ist. Klick feuert ein Window-Event, das
 * der App-Layout-Listener abfaengt und die Palette oeffnet.
 */
export function CommandPaletteTrigger({ onOpen }: { onOpen?: () => void }) {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    setMac(/Mac|iPod|iPhone|iPad/i.test(navigator.platform));
  }, []);
  const handle = () => {
    if (onOpen) onOpen();
    else if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(CMDK_OPEN_EVENT));
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-sidebar-border bg-sidebar-accent/60 dark:bg-white/[0.06] dark:border-white/15 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent dark:hover:bg-white/[0.10] dark:hover:border-white/25 transition-all w-full text-xs"
      aria-label="Suche öffnen"
      data-tooltip="Suche (⌘K)"
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 text-left">Suche…</span>
      <kbd className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border border-sidebar-border dark:border-white/15 bg-sidebar dark:bg-white/[0.04] text-sidebar-foreground/70 shrink-0">
        {mac ? "⌘K" : "Ctrl K"}
      </kbd>
    </button>
  );
}
