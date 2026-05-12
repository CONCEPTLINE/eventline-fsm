"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// App-weite Scroll-Position-Restauration.
//
// Vorherige Versionen scheiterten weil:
//  1. Ich hab geraten welcher Container scrollt (window vs #app-scroll
//     vs documentElement) — die CSS-Quirk-Konstellation macht das nicht
//     vorhersagbar.
//  2. Scroll-Events BUBBELN NICHT. Ein document.addEventListener("scroll")
//     ohne {capture:true} hoert von inner-Container-Scrolls nichts.
//  3. Beim initialen Loading-State existiert #app-scroll noch nicht;
//     useEffect lief danach nicht nochmal, Listener wurde nie ergaenzt.
//
// Diese Version: Capture-Phase-Listener auf document. Faengt scroll-
// Events von JEDEM Element ab (in der Capture-Phase propagiert auch
// non-bubbling Scroll bis runter durch alle Ancestors). Im Listener
// holen wir das tatsaechliche Event-Target — DAS ist der echte
// Scroll-Container. Per stabilen Selektor identifizieren, Position
// speichern, beim Restore exakt den gleichen Container wiederfinden.

type ScrollEntry = { sel: string; y: number };

const STORAGE_KEY = (url: string) => `scroll:${url}`;

// Stabiler Selektor fuer ein Scroll-Target. Reihenfolge:
//   1. window/document/documentElement -> "window" (alle dasselbe vom
//      Scroll-Verhalten her)
//   2. body -> "body"
//   3. id vorhanden -> "#id"
//   4. Tag + Position unter dem Parent (z.B. "main:nth-of-type(1)")
//      als Best-Effort. Funktioniert wenn die DOM-Struktur zwischen
//      Save und Restore stabil ist (was im App-Layout der Fall ist).
function selectorFor(target: EventTarget | null): string | null {
  if (!target) return null;
  if (target === window || target === document || target === document.documentElement) {
    return "window";
  }
  if (target === document.body) return "body";
  if (!(target instanceof Element)) return null;
  if (target.id) return `#${CSS.escape(target.id)}`;
  // Path bauen: tag + nth-of-type bis zum naechsten id-Anker oder body
  const parts: string[] = [];
  let el: Element | null = target;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.id) {
      parts.unshift(`#${CSS.escape(el.id)}`);
      break;
    }
    const parent: Element | null = el.parentElement;
    if (!parent) break;
    const tag = el.tagName.toLowerCase();
    const currentTag = el.tagName;
    const siblings: Element[] = Array.from(parent.children).filter((c) => c.tagName === currentTag);
    const idx = siblings.indexOf(el) + 1;
    parts.unshift(`${tag}:nth-of-type(${idx})`);
    el = parent;
  }
  return parts.join(" > ") || null;
}

function elementFor(sel: string): { el: Element | Window; isWindow: boolean } | null {
  if (sel === "window") return { el: window, isWindow: true };
  if (sel === "body") return { el: document.body, isWindow: false };
  try {
    const found = document.querySelector(sel);
    if (found) return { el: found, isWindow: false };
  } catch { /* invalid selector */ }
  return null;
}

function getY(el: Element | Window): number {
  return el instanceof Window ? el.scrollY : el.scrollTop;
}

function setY(el: Element | Window, y: number): void {
  if (el instanceof Window) el.scrollTo(0, y);
  else (el as HTMLElement).scrollTop = y;
}

export function useScrollRestoration() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const url = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : "");

  // Browser-Auto-Restore aus.
  useEffect(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let isRestoring = false;
    let cancelled = false;
    // Map von Selektor -> letzte Y-Position. Wir flushen das in
    // sessionStorage bei jedem Save (laufend) und beim Unmount.
    const positions: Map<string, number> = new Map();

    // Bisher persistierte Positionen vor-laden, damit die Map nicht bei
    // jeder URL-Wiederkehr ihre Vergangenheit vergisst (relevant fuer
    // Container die der User auf der vorherigen Visit-Runde gescrollt
    // hatte, aber diesmal noch nicht).
    let initial: ScrollEntry[] = [];
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY(url));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) initial = parsed;
      }
    } catch { /* ignore */ }
    for (const e of initial) {
      if (e && typeof e.sel === "string" && typeof e.y === "number") {
        positions.set(e.sel, e.y);
      }
    }

    const persist = () => {
      try {
        const arr: ScrollEntry[] = Array.from(positions.entries()).map(([sel, y]) => ({ sel, y }));
        sessionStorage.setItem(STORAGE_KEY(url), JSON.stringify(arr));
      } catch { /* ignore */ }
    };

    // Capture-Phase Listener auf document — faengt scroll-Events von
    // jedem Element ab, auch wenn der echte Scroller tief verschachtelt
    // ist. Scroll-Events bubbeln nicht, propagieren aber in Capture.
    const onScroll = (e: Event) => {
      if (isRestoring) return;
      const sel = selectorFor(e.target);
      if (!sel) return;
      const ref = elementFor(sel);
      if (!ref) return;
      positions.set(sel, getY(ref.el));
      persist();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });

    // Restore — fuer jeden persistierten Container die Position setzen.
    // Container der nicht (mehr) existiert wird stillschweigend
    // uebersprungen.
    if (positions.size > 0 && Array.from(positions.values()).some((y) => y > 0)) {
      isRestoring = true;
      let tries = 0;
      const restore = () => {
        if (cancelled) return;
        let allGood = true;
        positions.forEach((y, sel) => {
          if (y <= 0) return;
          const ref = elementFor(sel);
          if (!ref) return;
          setY(ref.el, y);
          if (Math.abs(getY(ref.el) - y) > 10) allGood = false;
        });
        if (!allGood && tries++ < 120) {
          // 120 Frames @ 60fps ≈ 2s — gibt Async-Daten genug Zeit zum
          // Laden bevor wir aufgeben.
          requestAnimationFrame(restore);
        } else {
          isRestoring = false;
        }
      };
      requestAnimationFrame(restore);
    }

    return () => {
      cancelled = true;
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      // Final-Persist: aktuelle Y's einsammeln. Geht ALLE bekannten
      // Selektoren durch und liest deren aktuelle Position — so kriegen
      // wir auch den Endstand wenn der User auf einen Schlag gescrollt
      // hat und sofort weiternaviiert hat (kurzer Scroll-Event-Stream).
      const finalArr: ScrollEntry[] = [];
      positions.forEach((_y, sel) => {
        const ref = elementFor(sel);
        if (!ref) return;
        const current = getY(ref.el);
        if (current > 0) finalArr.push({ sel, y: current });
      });
      try { sessionStorage.setItem(STORAGE_KEY(url), JSON.stringify(finalArr)); } catch { /* ignore */ }
    };
  }, [url]);
}
