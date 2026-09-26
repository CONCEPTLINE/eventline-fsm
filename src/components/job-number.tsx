"use client";

// Eine zentrale Stelle fuer die Optik der Auftragsnummer (INT-XXXXX).
// Wird ueberall verwendet wo eine job_number visuell angezeigt wird —
// damit eine Aenderung des Designs immer alle Stellen erreicht.
//
// Stil: mono + semibold + dezenter neutraler Hintergrund-Pill via foreground/[0.08].
// Theme-adaptiv (light = subtle gray, dark = subtle near-white). Keine Farbe — der
// Identifier soll auffallen durch Form, nicht durch Buntheit.
//
// Klick kopiert die Nummer (Leo 2026-09-26: "beim Hovern schnell
// kopieren") — stopPropagation, weil die Pille oft in klickbaren
// Karten/Links steckt und der Kopier-Klick NICHT navigieren darf.

import { useState } from "react";
import { toast } from "sonner";

interface JobNumberProps {
  number: number | null | undefined;
  /** Default 'sm' (text-xs). 'md' fuer Detail-Header, 'lg' fuer Hero-Anzeige, 'xl' fuer Page-Title. */
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeClasses = {
  sm: "text-sm px-2 py-0.5",
  // md: bewusst leichter als der H1-Titel — sonst konkurriert die
  // Nummer-Pill visuell mit dem Auftragstitel im Sticky-Header.
  md: "text-[13px] px-2 py-0.5",
  lg: "text-lg px-3 py-1",
  xl: "text-2xl px-3.5 py-1.5",
};

export function JobNumber({ number, size = "sm", className = "" }: JobNumberProps) {
  const [hover, setHover] = useState(false);
  if (!number) return null;
  const label = `INT-${number}`;

  function kopieren(e: { preventDefault: () => void; stopPropagation: () => void }) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(label).then(
      () => toast.success(`${label} kopiert`),
      () => toast.error("Kopieren fehlgeschlagen"),
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      data-tooltip="Kopieren"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={kopieren}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") kopieren(e); }}
      className={`inline-flex items-center font-mono font-semibold rounded-md bg-card border border-foreground/10 dark:border-foreground/15 tabular-nums whitespace-nowrap cursor-copy select-none ${sizeClasses[size]} ${className}`}
      style={{
        // Hover state-driven mit inline-style (Projekt-Regel) — dezent,
        // ohne Layout-Shift: nur Rand/Hintergrund werden kraeftiger.
        borderColor: hover ? "color-mix(in srgb, var(--foreground) 35%, transparent)" : undefined,
        background: hover ? "color-mix(in srgb, var(--foreground) 8%, var(--card))" : undefined,
        transition: "border-color 120ms, background-color 120ms",
      }}
    >
      {label}
    </span>
  );
}
