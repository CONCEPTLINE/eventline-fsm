"use client";

// Auftakt des Dashboards: beim ersten echten Ladevorgang der Sitzung zaehlen
// die Zahlen in 900 ms hoch (ease-out) und der Haken des Ruhe-Zustands
// zeichnet sich nach 240 ms. Ob ein Mount animiert, entscheidet die Seite
// (`animieren`: nur wenn der Auftakt in dieser Sitzung noch nicht lief —
// Flag in session-cache.ts); aus dem Session-Cache gerenderte Mounts und
// stille Aktualisierungen zeigen sofort den Endstand.
// prefers-reduced-motion: ebenfalls sofort der Endstand.

import { useEffect, useRef, useState } from "react";

const DAUER_MS = 900;
const HAKEN_NACH_MS = 240;

function bewegungReduziert(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export interface Auftakt {
  /** Fortschritt 0..1, bereits ease-out (kubisch) — Zahl × anteil = Anzeige. */
  anteil: number;
  /** Haken des Ruhe-Zustands gezeichnet. */
  haken: boolean;
}

/**
 * @param bereit Daten stehen — erst dann startet die Animation.
 * @param animieren Dieser Mount darf animieren (Wert beim Mount festlegen;
 *   false = sofort der Endstand, nichts laeuft).
 */
export function useAuftakt(bereit: boolean, animieren: boolean): Auftakt {
  const [stand, setStand] = useState<{ f: number; haken: boolean }>(() =>
    !animieren || bewegungReduziert() ? { f: 1, haken: true } : { f: 0, haken: false },
  );
  const fertig = useRef(false);

  useEffect(() => {
    // Endstand steht schon (kein Auftakt fuer diesen Mount, reduzierte
    // Bewegung) oder die Animation lief bereits: nichts mehr zu tun.
    if (!bereit || !animieren || fertig.current || bewegungReduziert()) return;
    let raf = 0;
    let start = 0;
    const schritt = (ts: number) => {
      if (!start) start = ts;
      const q = Math.min(1, (ts - start) / DAUER_MS);
      setStand((s) => (s.f === q ? s : { ...s, f: q }));
      if (q < 1) raf = window.requestAnimationFrame(schritt);
      else fertig.current = true;
    };
    raf = window.requestAnimationFrame(schritt);
    const uhr = window.setTimeout(() => setStand((s) => (s.haken ? s : { ...s, haken: true })), HAKEN_NACH_MS);
    // Abbruch (Unmount, StrictMode-Doppellauf): naechster Lauf startet neu.
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(uhr);
    };
  }, [bereit, animieren]);

  return { anteil: 1 - Math.pow(1 - stand.f, 3), haken: stand.haken };
}

/** Angezeigter Wert waehrend des Hochzaehlens. */
export function hochgezaehlt(n: number, anteil: number): number {
  return Math.round(n * anteil);
}
