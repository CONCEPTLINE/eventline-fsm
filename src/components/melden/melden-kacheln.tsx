"use client";

/**
 * «Melden»-Kacheln: Beleg · Krank · Abwesenheit · Stempel korrigieren +
 * Link «Anderes melden (IT, Material)». Jede Kachel oeffnet direkt das
 * passende Formular (oeffneMelden → MeldenHost). Genutzt in Mein Konto
 * (Laptop + Handy) und auf Meine Anfragen.
 *
 * Handy: 2×2-Raster, Kachel min. 64 px. Laptop: eine Reihe.
 */

import { Clock, Palmtree, Receipt, ThermometerSun, ChevronRight, type LucideIcon } from "lucide-react";
import { ANDERES_LABEL, MELDEN_KACHELN, darfMelden, oeffneMelden, type MeldenArt } from "@/lib/melden";
import { usePermissions } from "@/lib/use-permissions";
import { TextKnopf } from "@/components/ui/text-knopf";

export const MELDEN_ICONS: Record<MeldenArt, LucideIcon> = {
  beleg: Receipt,
  krank: ThermometerSun,
  abwesenheit: Palmtree,
  stempel: Clock,
  anderes: ChevronRight,
};

export function MeldenKacheln({ kompakt = false }: { kompakt?: boolean }) {
  const { can } = usePermissions();
  const kacheln = MELDEN_KACHELN.filter((k) => darfMelden(k.art, can));
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
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold leading-tight">{k.label}</span>
                <span className="block text-[12px] text-muted-foreground">{k.hinweis}</span>
              </span>
            </button>
          );
        })}
      </div>
      {darfMelden("anderes", can) && (
        <TextKnopf onClick={() => oeffneMelden("anderes")} className="inline-flex min-h-[34px] items-center px-1 text-[13px] text-muted-foreground">
          {ANDERES_LABEL} ›
        </TextKnopf>
      )}
    </div>
  );
}
