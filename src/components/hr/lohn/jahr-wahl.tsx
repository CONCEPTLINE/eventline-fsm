"use client";

/**
 * Jahr-Umschalter (‹ 2026 ›) für die Lohn-Karten (Korrektur-Vorschläge,
 * Jahresliste) samt Merken im localStorage (CLAUDE.md §10). Optik wie die
 * Monats-Navigation der Monatsstunden.
 */

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { todayLocalIso } from "@/lib/swiss-time";

export const JAHR_MIN = 2020;

export function aktuellesJahr(): number {
  return Number(todayLocalIso().slice(0, 4));
}

/** Persönliche Auswahl aus dem localStorage — immer mit Fallback. */
export function gemerkt(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function merke(key: string, wert: string) {
  try {
    window.localStorage.setItem(key, wert);
  } catch {
    /* privater Modus o. ä. — Auswahl gilt dann nur bis zum Neuladen */
  }
}

/** Jahr mit localStorage-Merker (gültig: 2020 bis nächstes Jahr). */
export function useGemerktesJahr(key: string): [number, (j: number) => void] {
  const [jahr, setJahr] = useState<number>(() => {
    const max = aktuellesJahr() + 1;
    const v = Number(gemerkt(key, ""));
    return Number.isInteger(v) && v >= JAHR_MIN && v <= max ? v : aktuellesJahr();
  });
  useEffect(() => { merke(key, String(jahr)); }, [key, jahr]);
  return [jahr, setJahr];
}

/** Beliebiger Text-Zustand mit localStorage-Merker. */
export function useGemerkt<T extends string>(key: string, fallback: T, erlaubt: readonly T[]): [T, (v: T) => void] {
  const [wert, setWert] = useState<T>(() => {
    const v = gemerkt(key, fallback);
    return (erlaubt as readonly string[]).includes(v) ? (v as T) : fallback;
  });
  useEffect(() => { merke(key, wert); }, [key, wert]);
  return [wert, setWert];
}

export function JahrWahl({ jahr, onChange, disabled }: { jahr: number; onChange: (j: number) => void; disabled?: boolean }) {
  const max = aktuellesJahr() + 1;
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(jahr - 1)}
        disabled={disabled || jahr <= JAHR_MIN}
        className="p-1.5 rounded-lg border border-border hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08] disabled:opacity-40"
        aria-label="Vorheriges Jahr"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="min-w-[3.25rem] text-center text-sm font-semibold tabular-nums">{jahr}</span>
      <button
        type="button"
        onClick={() => onChange(jahr + 1)}
        disabled={disabled || jahr >= max}
        className="p-1.5 rounded-lg border border-border hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08] disabled:opacity-40"
        aria-label="Nächstes Jahr"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
