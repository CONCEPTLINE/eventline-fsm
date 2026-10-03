"use client";

// Gemeinsame Bausteine der Dashboard-Bereiche: Karten-Rahmen, Farbtoene,
// Ruhe-Flaeche, Text-Link und die Zeilen-Liste, die die Breite nutzt.

import { useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Farbton einer Zeile/Pille. Dark-Mode bewusst kraeftiger (CLAUDE.md §3). */
export type Ton = "rot" | "amber" | "gruen" | "neutral";

export const TON_KLASSEN: Record<Ton, string> = {
  rot: "bg-red-500/10 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  amber: "bg-amber-500/15 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  gruen: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  neutral: "bg-foreground/[0.06] text-foreground/75 dark:bg-foreground/[0.12] dark:text-foreground/80",
};

/** Dezenter Flaechenton innerhalb einer Karte (Kacheln, Unterlisten). */
export const FLAECHE = "bg-foreground/[0.04] dark:bg-foreground/[0.08]";

export function Karte({
  titel,
  icon: Icon,
  rechts,
  className,
  children,
}: {
  titel: string;
  icon: LucideIcon;
  /** Optionaler Inhalt rechts neben dem Titel (Zusammenfassung, Navigation). */
  rechts?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // min-w-0: im Raster darf die Karte schmaler werden als ihr laengster
    // Text (der wird dann innen gekuerzt), sonst sprengt sie die Spalte.
    <section aria-label={titel} className={cn("flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card p-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h2 className="flex min-w-0 items-center gap-2.5 font-heading text-lg font-bold">
          <Icon className="h-[18px] w-[18px] shrink-0 text-accent" aria-hidden />
          <span className="truncate">{titel}</span>
        </h2>
        {rechts}
      </div>
      {children}
    </section>
  );
}

/** Ruhe-Zustand «nichts offen» mit gezeichnetem Haken (Auftakt, use-auftakt.ts)
 *  — gleiche Darstellung in «Braucht Aufmerksamkeit» und «Meine Todos».
 *  flex-1: im Raster ist die Karte so hoch wie ihr Nachbar — die Flaeche
 *  fuellt den Platz statt leer darunter zu lassen. */
export function RuheFlaeche({
  titel,
  haken,
  className,
  children,
}: {
  titel: string;
  /** Haken gezeichnet. */
  haken: boolean;
  className?: string;
  /** Unterzeile. */
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-1 items-center gap-4 rounded-xl bg-emerald-500/10 p-[18px] dark:bg-emerald-500/15", className)}>
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-card">
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="text-emerald-700 dark:text-emerald-300"
        >
          <path
            d="M20 6 9 17l-5-5"
            style={{
              strokeDasharray: 24,
              strokeDashoffset: haken ? 0 : 24,
              transition: haken ? "stroke-dashoffset 700ms cubic-bezier(.2,.8,.2,1)" : "none",
            }}
          />
        </svg>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="font-heading text-[17px] font-bold text-emerald-700 dark:text-emerald-300">{titel}</b>
        <span className="text-[13px] text-foreground/75">{children}</span>
      </span>
    </div>
  );
}

/** Text-Link in Karten (Fusszeilen, Ruhe-Flaechen) — Schrift erbt die
 *  Umgebung. Hover state-driven (Projekt-Regel): dunkler, unterstrichen. */
export function KartenLink({ href, children }: { href: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <Link
      href={href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="font-semibold"
      style={{
        color: hover ? "var(--foreground)" : "color-mix(in srgb, var(--foreground) 75%, transparent)",
        textDecoration: hover ? "underline" : "none",
        textUnderlineOffset: 3,
      }}
    >
      {children}
    </Link>
  );
}

/** Zeilen-Liste, die die Breite nutzt: so viele Spalten, wie Zeilen von
 *  mindestens `min` px nebeneinander passen (auto-fill) — im 42-%-Platz
 *  eine, in voller Breite mehrere. Trennlinien wie divide-y, aber je
 *  Spalte: jede Zeile traegt oben eine Linie, die der obersten Reihe ist
 *  weggeschnitten (clip-path; seitlich und unten Luft fuer Fokus-Ringe) —
 *  so stimmt es bei jeder Spaltenzahl und jeder Zeilenzahl. */
export function ZeilenRaster({
  min,
  className,
  children,
}: {
  /** Mindestbreite einer Zeile in px. */
  min: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("-mt-px [clip-path:inset(1px_-8px_-8px_-8px)]", className)}>
      <div
        className="grid gap-x-6 *:border-t"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}px), 1fr))` }}
      >
        {children}
      </div>
    </div>
  );
}
