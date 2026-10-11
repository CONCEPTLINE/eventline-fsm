"use client";

import { useEffect, useState } from "react";

/** Handy-Breakpoint = Tailwind `md` (768 px). EINE Wahrheit fuer alle
 *  JS-Weichen der Mobile-Schicht (CSS nutzt dieselbe Grenze via md:). */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * true = Handy (< 768 px), false = Desktop, null = noch unbekannt (SSR und
 * erster Client-Render). Hydration-sicher: der Server kennt die Breite nicht,
 * darum liefert der erste Render null. Komponenten entscheiden die ERSTE
 * Darstellung per CSS (md:hidden / hidden md:flex) und nutzen den Hook nur
 * fuer Logik, die nicht doppelt laufen darf (Timer, Fetches, Popups).
 */
export function useIsMobile(): boolean | null {
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return isMobile;
}
