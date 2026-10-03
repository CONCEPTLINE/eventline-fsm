"use client";

// Bereich «Naechster Einsatz»: der eigene naechste Termin mit Datums-Kachel,
// Zeit, Auftrag und Ort — oder ein ruhiger Hinweis, wenn keiner geplant ist.

import Link from "next/link";
import { Briefcase, ChevronRight, MapPin, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EinsatzDaten } from "@/components/dashboard/typen";
import { FLAECHE, Karte } from "@/components/dashboard/karte";
import { datumKachel, einsatzTag, zeitspanne } from "@/components/dashboard/format";

export function EinsatzKarte({ daten }: { daten: EinsatzDaten }) {
  const e = daten.naechster;
  return (
    <Karte titel="Nächster Einsatz" icon={Briefcase}>
      {e ? (
        <>
          <div className="flex items-stretch gap-4">
            <DatumKachel start={e.start} />
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
              <b className="text-base font-semibold">
                {einsatzTag(e.start)} · {zeitspanne(e.start, e.ende)}
              </b>
              <span className="truncate text-sm text-foreground/80">
                {e.auftrag_nr != null && (
                  <>
                    <b className="font-semibold">INT-{e.auftrag_nr}</b>
                    {" · "}
                  </>
                )}
                {e.titel}
                {e.aufgabe && <span className="text-muted-foreground"> · {e.aufgabe}</span>}
              </span>
              {(e.ort || e.adresse) && (
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{e.ort ?? e.adresse}</span>
                </span>
              )}
            </div>
          </div>
          {/* mt-auto: Fusszeile unten, wenn die Karte im Raster hoeher ist als ihr Inhalt. */}
          <Link href="/kalender?from=dashboard" className="kasten kasten-muted mt-auto self-start">
            Im Kalender öffnen
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </>
      ) : (
        // flex-1: die Ruhe-Flaeche fuellt die Karte, wenn der Nachbar hoeher ist.
        <div className={cn("flex flex-1 items-center gap-3.5 rounded-xl p-4", FLAECHE)}>
          <Sun className="h-[22px] w-[22px] shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
          <span className="flex flex-col gap-0.5">
            <b className="text-[15px] font-semibold">Kein Einsatz geplant</b>
            <span className="text-[13px] text-foreground/75">Geniess die ruhigen Tage. Neue Einsätze erscheinen hier.</span>
          </span>
        </div>
      )}
    </Karte>
  );
}

function DatumKachel({ start }: { start: string }) {
  const k = datumKachel(start);
  return (
    <div className="flex w-[66px] shrink-0 flex-col items-center overflow-hidden rounded-xl border bg-card">
      <span className="self-stretch bg-accent py-1 text-center text-[11px] font-bold tracking-[0.1em] text-white">
        {k.wochentag}
      </span>
      <span className="pt-1.5 font-heading text-[27px] font-bold leading-[1.1]">{k.tag}</span>
      <span className="pb-[7px] text-[11px] tracking-[0.08em] text-muted-foreground">{k.monat}</span>
    </div>
  );
}
