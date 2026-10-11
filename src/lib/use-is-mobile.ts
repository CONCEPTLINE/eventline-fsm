"use client";

import { useSyncExternalStore } from "react";

/** Handy-Breakpoint = Tailwind `md` (768 px). EINE Wahrheit fuer alle
 *  JS-Weichen der Mobile-Schicht (CSS nutzt dieselbe Grenze via md:). */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

// Eine MediaQueryList fuer alle Abonnenten (lazy, nur im Browser).
let mql: MediaQueryList | null = null;
function mediaQuery(): MediaQueryList {
  if (!mql) mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  return mql;
}

function subscribe(onChange: () => void) {
  const m = mediaQuery();
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

function getSnapshot(): boolean | null {
  return mediaQuery().matches;
}

function getServerSnapshot(): boolean | null {
  return null;
}

/**
 * true = Handy (< 768 px), false = Desktop, null = Breite noch unbekannt.
 * null gibt es NUR waehrend SSR und dem Hydration-Render (der Server kennt
 * die Breite nicht, React nimmt dafuer den Server-Snapshot). Jeder spaetere
 * Mount (Soft-Navigation) liest matchMedia sofort und liefert im ersten
 * Render den richtigen Wert — kein Desktop-Baum, der am Handy gleich wieder
 * ausgetauscht wird. Weichen rendern bei null ein Skelett ohne Effekte.
 */
export function useIsMobile(): boolean | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
