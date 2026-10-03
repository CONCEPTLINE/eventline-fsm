// Gemeinsame Bausteine der Dashboard-Bereiche: Karten-Rahmen und Farbtoene.

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
