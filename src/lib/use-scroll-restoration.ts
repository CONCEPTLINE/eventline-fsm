"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// Scroll-Position-Restauration — minimalistische Version mit Debug-Output.
//
// Funktioniert mit jedem Scroll-Container im App-Layout (window oder
// inner-Div) weil:
//   - Capture-Phase-Listener auf document faengt scroll-Events von jedem
//     Element ab (scroll-Events bubbeln nicht, propagieren aber in
//     Capture).
//   - Das event.target wird via stabilen Selektor (id oder DOM-Pfad)
//     identifiziert. Beim Restore wird derselbe Selektor wieder aufgeloest.
//   - Save passiert NUR auf Scroll-Events. Keine final-save im Cleanup —
//     der koennte den korrekten Wert mit dem post-Next.js-scrollTo-0
//     ueberschreiben.
//
// Debug: setzt window.__scrollDebug global zum Inspizieren in DevTools.

type Saved = Record<string, number>;

const KEY = (u: string) => `scroll:${u}`;

declare global {
  interface Window {
    __scrollDebug?: {
      url: string;
      saved: Saved;
      lastEventTarget: string | null;
      lastEventY: number | null;
      restoreAttempts: number;
      restoreApplied: boolean;
    };
  }
}

function selectorOf(t: EventTarget | null): string | null {
  if (!t) return null;
  if (t === window || t === document) return "window";
  if (!(t instanceof Element)) return null;
  if (t === document.documentElement) return "window";
  if (t === document.body) return "body";
  if (t.id) return `#${CSS.escape(t.id)}`;
  const parts: string[] = [];
  let el: Element | null = t;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.id) {
      parts.unshift(`#${CSS.escape(el.id)}`);
      break;
    }
    const parent: Element | null = el.parentElement;
    if (!parent) break;
    const currentTag = el.tagName;
    const siblings: Element[] = Array.from(parent.children).filter((c) => c.tagName === currentTag);
    const idx = siblings.indexOf(el) + 1;
    parts.unshift(`${currentTag.toLowerCase()}:nth-of-type(${idx})`);
    el = parent;
  }
  return parts.join(" > ") || null;
}

function resolve(sel: string): { read: () => number; write: (y: number) => void } | null {
  if (sel === "window") {
    // document.scrollingElement ist die kanonische Quelle fuer Document-
    // Scroll-Position. ||-Chain mit body.scrollTop war ein Bug — body
    // kann via CSS-Quirk eigenes scrollTop tracken auch wenn's nichts
    // scrollt, und unser write hatte's auf 1366 gesetzt was read als
    // "Erfolg" interpretiert hat obwohl nichts gescrollt war.
    return {
      read: () => document.scrollingElement?.scrollTop ?? window.scrollY ?? 0,
      write: (y) => { window.scrollTo(0, y); },
    };
  }
  if (sel === "body") {
    return {
      read: () => document.body.scrollTop,
      write: (y) => { document.body.scrollTop = y; },
    };
  }
  let el: Element | null = null;
  try { el = document.querySelector(sel); } catch { return null; }
  if (!el) return null;
  const html = el as HTMLElement;
  return {
    read: () => html.scrollTop,
    write: (y) => { html.scrollTop = y; },
  };
}

export function useScrollRestoration() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const url = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : "");

  useEffect(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Saved-Map aus sessionStorage laden.
    const saved: Saved = (() => {
      try {
        const raw = sessionStorage.getItem(KEY(url));
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch { return {}; }
    })();

    // Debug-Object global verfuegbar machen (in DevTools-Console
    // inspizierbar als window.__scrollDebug). Hilft bei kuenftiger
    // Diagnose ohne Memory-Leak (bounded object, kein history-array).
    window.__scrollDebug = {
      url,
      saved: { ...saved },
      lastEventTarget: null,
      lastEventY: null,
      restoreAttempts: 0,
      restoreApplied: false,
    };

    let cancelled = false;

    // Save auf Scroll-Events. Capture-Phase auf document faengt alle
    // Scrolls — auch von tief verschachtelten Containern (Scroll-Events
    // bubbeln nicht, aber propagieren in Capture).
    //
    // WICHTIG: URL-Stale-Check. Race-Condition: router.push aendert
    // window.location SYNCHRON, danach scrollt Next.js zum Top (= 0).
    // Das scroll-Event feuert BEVOR React den useEffect-Cleanup
    // ausgefuehrt hat — der alte Listener (mit alter url im closure)
    // wuerde sonst y=0 unter dem ALTEN URL-Key speichern und damit den
    // korrekten gespeicherten Wert ueberschreiben. Vorzeitig bail wenn
    // window.location.pathname nicht mehr unserer closure-url entspricht.
    const onScroll = (e: Event) => {
      const currentUrl = window.location.pathname +
        (window.location.search || "");
      if (currentUrl !== url) return; // stale listener, navigation in progress
      const sel = selectorOf(e.target);
      if (!sel) return;
      const r = resolve(sel);
      if (!r) return;
      const y = r.read();
      saved[sel] = y;
      try { sessionStorage.setItem(KEY(url), JSON.stringify(saved)); } catch { /* ignore */ }
      if (window.__scrollDebug) {
        window.__scrollDebug.lastEventTarget = sel;
        window.__scrollDebug.lastEventY = y;
        window.__scrollDebug.saved = { ...saved };
      }
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });

    // Restore — jeden gespeicherten Container auf seine Y setzen. RAF-
    // Retry bis target fuer 2 aufeinanderfolgende Frames stabil erreicht
    // ist ODER Budget (~2s) erschoepft. Stable-Frames-Termination statt
    // 1s-blind-Loop: User kann sofort scrollen sobald restore-target
    // tatsaechlich anliegt, ohne dass mein restore weiterfeuert. Falls
    // Async-Daten erst spaeter laden, retriet die Schleife weiter bis
    // target erreichbar ist.
    const targets = Object.entries(saved).filter(([, y]) => y > 0);
    if (targets.length > 0) {
      let tries = 0;
      let stableFrames = 0;
      const MAX_TRIES = 120; // ~2s @ 60fps
      const restore = () => {
        if (cancelled) return;
        let allClose = true;
        for (const [sel, y] of targets) {
          const r = resolve(sel);
          if (!r) continue;
          r.write(y);
          if (Math.abs(r.read() - y) > 10) allClose = false;
        }
        if (allClose) stableFrames++;
        else stableFrames = 0;
        if (window.__scrollDebug) {
          window.__scrollDebug.restoreAttempts = tries + 1;
          window.__scrollDebug.restoreApplied = allClose;
        }
        if (stableFrames < 2 && tries++ < MAX_TRIES) {
          requestAnimationFrame(restore);
        }
      };
      requestAnimationFrame(restore);
    }

    return () => {
      cancelled = true;
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [url]);
}
