"use client";

/**
 * «Melden»-Kacheln: Beleg · Krank · Abwesenheit · Stempel korrigieren +
 * Link «Anderes melden (IT, Material)». Jede Kachel oeffnet direkt das
 * passende Formular (oeffneMelden → MeldenHost). Genutzt in Mein Konto
 * (Laptop + Handy).
 *
 * Handy: 2×2-Raster, Kachel min. 64 px, mit Rand wie die gruppierten Listen.
 * Laptop (`flaeche`, in einer Dashboard-Karte): eine Reihe, Kacheln als
 * getoente Flaeche ohne Rand (wie die Kacheln im Dashboard, FLAECHE); «Anderes
 * melden» steht dann rechts im Kartenkopf (AnderesMeldenKnopf).
 *
 * Icon-Farben je Art wie auf Meine Anfragen und /tickets: Beleg amber,
 * Krank rot, Abwesenheit blau, Stempel gruen.
 */

import { Clock, Palmtree, Receipt, ThermometerSun, ChevronRight, type LucideIcon } from "lucide-react";
import { ANDERES_LABEL, MELDEN_KACHELN, darfMelden, oeffneMelden, type MeldenArt } from "@/lib/melden";
import { usePermissions } from "@/lib/use-permissions";
import { TextKnopf } from "@/components/ui/text-knopf";
import { FLAECHE } from "@/components/dashboard/karte";

export const MELDEN_ICONS: Record<MeldenArt, LucideIcon> = {
  beleg: Receipt,
  krank: ThermometerSun,
  abwesenheit: Palmtree,
  stempel: Clock,
  anderes: ChevronRight,
};

/** Getoente Icon-Kachel je Art (Dark kraeftiger, CLAUDE.md §3). */
const MELDEN_TON: Record<Exclude<MeldenArt, "anderes">, string> = {
  beleg: "bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-amber-200",
  krank: "bg-red-100 text-red-700 dark:bg-red-500/25 dark:text-red-200",
  abwesenheit: "bg-blue-100 text-blue-700 dark:bg-blue-500/25 dark:text-blue-200",
  stempel: "bg-green-100 text-green-700 dark:bg-green-500/25 dark:text-green-200",
};

/** «Anderes melden (IT, Material) ›» — nur wenn die Person es darf. */
export function AnderesMeldenKnopf({ className }: { className?: string }) {
  const { can } = usePermissions();
  if (!darfMelden("anderes", can)) return null;
  return (
    <TextKnopf onClick={() => oeffneMelden("anderes")} className={className}>
      {ANDERES_LABEL} ›
    </TextKnopf>
  );
}

export function MeldenKacheln({ kompakt = false, flaeche = false }: { kompakt?: boolean; flaeche?: boolean }) {
  const { can } = usePermissions();
  const kacheln = MELDEN_KACHELN.filter((k) => darfMelden(k.art, can));

  if (flaeche) {
    return (
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {kacheln.map((k) => {
          const Icon = MELDEN_ICONS[k.art];
          return (
            <button
              key={k.art}
              type="button"
              onClick={() => oeffneMelden(k.art)}
              className={`row-hover [--row-hover-x:0px] [--row-hover-radius:0.75rem] flex min-w-0 items-center gap-3 rounded-xl px-4 py-3.5 text-left ${FLAECHE}`}
            >
              <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${MELDEN_TON[k.art]}`}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold leading-tight">{k.label}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{k.hinweis}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className={`grid grid-cols-2 gap-2 ${kompakt ? "" : "md:grid-cols-4"}`}>
        {kacheln.map((k) => {
          const Icon = MELDEN_ICONS[k.art];
          return (
            <button
              key={k.art}
              type="button"
              onClick={() => oeffneMelden(k.art)}
              className="card-hover flex min-h-[64px] items-start gap-3 rounded-xl border border-border bg-card p-3 text-left"
            >
              <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${MELDEN_TON[k.art]}`}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold leading-tight">{k.label}</span>
                <span className="block text-[12px] text-muted-foreground">{k.hinweis}</span>
              </span>
            </button>
          );
        })}
      </div>
      <AnderesMeldenKnopf className="inline-flex min-h-[34px] items-center px-1 text-[13px] text-muted-foreground" />
    </div>
  );
}
