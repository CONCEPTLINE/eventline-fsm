"use client";

// Bereich «Mein Monat»: eigene Stunden bisher und die Prognose zum
// Monatsende (inkl. Netto-CHF), darunter wie weit der Monat ist.

import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MonatDaten } from "@/components/dashboard/typen";
import { FLAECHE, Karte, KartenLink } from "@/components/dashboard/karte";
import { ganzzahl, monatName, stunden1 } from "@/components/dashboard/format";

export function MonatKarte({ daten }: { daten: MonatDaten }) {
  const anteil = daten.tage_im_monat > 0 ? Math.min(1, daten.tag / daten.tage_im_monat) : 0;
  return (
    <Karte
      titel="Mein Monat"
      icon={Clock}
      rechts={<span className="text-xs text-muted-foreground">{monatName(daten.monat)}</span>}
    >
      <div className="grid grid-cols-2 gap-3">
        <Kachel label="Stunden bisher" wert={`${stunden1(daten.stunden)} h`} />
        <Kachel
          label="Prognose Monatsende"
          wert={`${ganzzahl(daten.prognose_stunden)} h`}
          unter={daten.prognose_chf != null ? `≈ CHF ${ganzzahl(daten.prognose_chf)}` : "Kein Lohn hinterlegt"}
        />
      </div>
      {/* mt-auto: Fusszeile unten, wenn die Karte im Raster hoeher ist als ihr Inhalt. */}
      <div className="mt-auto flex flex-col gap-1.5">
        <div className={cn("h-1.5 overflow-hidden rounded-full", FLAECHE)}>
          <div className="h-full rounded-full bg-foreground" style={{ width: `${(anteil * 100).toFixed(1)}%` }} />
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            Tag {daten.tag} von {daten.tage_im_monat}
          </span>
          <KartenLink href="/stempelzeiten?from=dashboard">Zu meinen Stempelzeiten</KartenLink>
        </div>
      </div>
    </Karte>
  );
}

function Kachel({ label, wert, unter }: { label: string; wert: string; unter?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 rounded-xl px-4 py-3.5", FLAECHE)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <b className="font-heading text-[26px] font-bold leading-tight tabular-nums">{wert}</b>
      {unter && <span className="truncate text-xs text-foreground/75">{unter}</span>}
    </div>
  );
}
