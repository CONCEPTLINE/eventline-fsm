"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

// App-weite Scroll-Position-Restauration.
//
// Strategie: bei JEDER URL-Aenderung versuchen, gespeicherte Positionen
// fuer diese URL wiederherzustellen. Keine popstate-Detection — die war
// in Next.js App-Router nicht zuverlaessig (Race zwischen Listener,
// router-Internals und Effect-Run).
//
// Multi-Container: weil das (app)-Layout mit overflow-x:hidden auf
// mehreren Ebenen arbeitet kann der echte Scroll-Container je nach
// Render-Zustand window ODER #app-scroll ODER documentElement sein —
// CSS-Quirk macht das schwer vorhersagbar. Wir speichern alle und
// restoren alle; der falsche ist ein no-op.
//
// RAF-Retry weil Listen erst nach Async-Datenload waxen.
//
// Forward-Nav zu einer URL die der User schon besucht hat: restored
// auch (gewuenschtes UX-Verhalten "bring mich zurueck wo ich war").
// Brand-neue URLs: kein saved-Wert -> no-op, Next.js' Default greift.

type Snap = { w: number; a: number; d: number };

const STORAGE_KEY = (url: string) => `scroll:${url}`;

function getApp(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("app-scroll");
}

function capture(): Snap {
  if (typeof window === "undefined") return { w: 0, a: 0, d: 0 };
  return {
    w: window.scrollY,
    a: getApp()?.scrollTop ?? 0,
    d: document.documentElement.scrollTop,
  };
}

function apply(snap: Snap): void {
  if (typeof window === "undefined") return;
  if (snap.w > 0) window.scrollTo(0, snap.w);
  const app = getApp();
  if (app && snap.a > 0) app.scrollTop = snap.a;
  if (snap.d > 0) document.documentElement.scrollTop = snap.d;
}

function effectiveScroll(snap: Snap): number {
  return Math.max(snap.w, snap.a, snap.d);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 10;
}

export function useScrollRestoration() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const url = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : "");

  // Browser-Auto-Restore aus — sonst springt der Browser auf 0 bevor
  // Async-Daten geladen und Page-Hoehe geupdated ist.
  useEffect(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let isRestoring = false;
    let cancelled = false;

    const save = () => {
      if (isRestoring) return;
      try {
        sessionStorage.setItem(STORAGE_KEY(url), JSON.stringify(capture()));
      } catch { /* quota oder private-mode — ignore */ }
    };

    // Auf allen plausiblen Scroll-Quellen lauschen. Was nicht scrollt,
    // feuert eh nicht.
    window.addEventListener("scroll", save, { passive: true });
    const app = getApp();
    app?.addEventListener("scroll", save, { passive: true });
    document.addEventListener("scroll", save, { passive: true });

    // Restore versuchen — wenn diese URL schon mal besucht wurde gibt's
    // einen saved-Snap, sonst no-op.
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(STORAGE_KEY(url)); } catch { /* ignore */ }
    let target: Snap | null = null;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object") {
          target = {
            w: Number(parsed.w) || 0,
            a: Number(parsed.a) || 0,
            d: Number(parsed.d) || 0,
          };
        }
      } catch { /* ignore */ }
    }

    if (target && effectiveScroll(target) > 0) {
      isRestoring = true;
      let tries = 0;
      const desired = effectiveScroll(target);
      const restore = () => {
        if (cancelled) return;
        apply(target!);
        // Erfolg = irgendein Container hat den gewuenschten Wert (close).
        // So wird nicht gegen einen Container retriet der gar nicht
        // scrollt (immer 0).
        const now = capture();
        const ok =
          close(now.w, target!.w) && close(now.a, target!.a) && close(now.d, target!.d) ||
          close(effectiveScroll(now), desired);
        if (!ok && tries++ < 30) {
          requestAnimationFrame(restore);
        } else {
          isRestoring = false;
          try { sessionStorage.setItem(STORAGE_KEY(url), JSON.stringify(capture())); } catch { /* ignore */ }
        }
      };
      requestAnimationFrame(restore);
    }

    return () => {
      cancelled = true;
      window.removeEventListener("scroll", save);
      app?.removeEventListener("scroll", save);
      document.removeEventListener("scroll", save);
      if (!isRestoring) {
        try { sessionStorage.setItem(STORAGE_KEY(url), JSON.stringify(capture())); } catch { /* ignore */ }
      }
    };
  }, [url]);
}
