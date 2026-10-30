"use client";

// Gemessene Listen des Buero-Bildschirms (aus page.tsx herausgeloest
// 2026-10-30, damit Firma und Vertrieb dieselbe Messung nutzen).

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** Wie viele `.b-fit`-Kinder passen in den Container (Platz fuer die
 *  "+n weitere"-Zeile freigehalten)? null = noch nicht gemessen → alle
 *  rendern, messen, dann kuerzen (useLayoutEffect, also vor dem Paint). */
export function useZeilenPassen(ref: RefObject<HTMLDivElement | null>, key: string, reserveEm: number): number | null {
  const [max, setMax] = useState<number | null>(null);
  useLayoutEffect(() => { setMax(null); }, [key]);
  useLayoutEffect(() => {
    if (max !== null) return;
    const el = ref.current;
    if (!el) return;
    const em = parseFloat(getComputedStyle(el).fontSize) || 16;
    const limit = el.getBoundingClientRect().bottom;
    const kinder = Array.from(el.children) as HTMLElement[];
    const zaehle = (grenze: number) => {
      let n = 0;
      for (const k of kinder) {
        if (k.getBoundingClientRect().bottom > grenze) return { n, alle: false };
        if (k.classList.contains("b-fit")) n++;
      }
      return { n, alle: true };
    };
    const voll = zaehle(limit);
    setMax(voll.alle ? Number.MAX_SAFE_INTEGER : zaehle(limit - reserveEm * em).n);
  }, [max, ref, reserveEm]);
  useEffect(() => {
    const onResize = () => setMax(null);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return max;
}
