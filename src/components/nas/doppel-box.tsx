"use client";

// Doppel-Hinweis der lokalen KI (Migration 334, lib/ki/doppel) — EINE Darstellung fuer «Einsortieren» (ZZ-Zeile im
// Detail) und die Ablage-Karte (Upload, Mail-Eingang): Mini-Vorschau beider Dateien, Pfad der anderen, Aktionen
// kompakt in zwei Zeilen. Verschoben wird nur auf Klick, beim naechsten Sync; nichts wird geloescht. Aktionen
// erscheinen nur, wenn der Aufrufer sie anbietet: «Doppel entfernen» (gleich/inhalt), «Als neue Fassung ablegen»
// (neuere Fassung: alte in die Historie daneben, diese an ihren Platz), «Beide behalten» (Hinweis weg).

import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Archive, Copy, History, Loader2 } from "lucide-react";
import { DOPPEL_QUARANTAENE, type DoppelHinweis } from "@/lib/ki/doppel";
import { ZzVorschau } from "./zz-vorschau";

/** Chip in der Zeile — kompakt, Text und Pfad im Tooltip, Aktionen im Detail. */
export const DOPPEL_CHIP: Record<DoppelHinweis["art"], { label: string; klasse: string; text: string }> = {
  exakt: {
    label: "Doppel",
    klasse: "bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-100",
    text: "Liegt schon unter",
  },
  inhalt: {
    label: "gleicher Inhalt",
    klasse: "border border-violet-300 text-violet-800 dark:border-violet-400/50 dark:text-violet-200",
    text: "Wahrscheinlich gleiches Dokument (andere Form) wie",
  },
  fassung_neu: {
    label: "neuere Fassung",
    klasse: "border border-sky-300 text-sky-800 dark:border-sky-400/50 dark:text-sky-200",
    text: "Neuere Fassung von",
  },
  fassung_alt: {
    label: "ältere Fassung",
    klasse: "bg-muted text-muted-foreground",
    text: "Es gibt eine neuere Fassung:",
  },
};

export function DoppelBox({
  supabase, pfad, eigeneVorschau, hinweis, laeuft, onEntfernen, onBehalten, onFassung,
  fassungTooltip = "Alte Fassung in den Historie-Ordner daneben, diese an ihren Platz (Name aus dem Feld unten)",
}: {
  supabase: SupabaseClient;
  /** Eigene Datei auf dem NAS (Mini-Vorschau vom Rig) — oder, wenn sie noch nicht dort liegt, `eigeneVorschau`. */
  pfad?: string;
  eigeneVorschau?: ReactNode;
  hinweis: DoppelHinweis;
  laeuft: boolean;
  onEntfernen?: () => void;
  onBehalten?: () => void;
  onFassung?: () => void;
  fassungTooltip?: string;
}) {
  const anderer = hinweis.andere[0];
  const chip = DOPPEL_CHIP[hinweis.art];
  const entfernen = (hinweis.art === "exakt" || hinweis.art === "inhalt") && onEntfernen;
  const fassung = hinweis.art === "fassung_neu" && onFassung;
  const behalten = hinweis.art !== "exakt" && onBehalten;
  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/70 px-2 py-1.5 text-[11px] dark:border-violet-500/35 dark:bg-violet-500/10" data-testid="zz-doppel-box">
      <div className="flex min-w-0 items-center gap-1.5">
        {pfad ? <ZzVorschau supabase={supabase} pfad={pfad} /> : eigeneVorschau}
        <span className="shrink-0 text-violet-700 dark:text-violet-300">↔</span>
        <ZzVorschau supabase={supabase} pfad={anderer.pfad} />
        <span className="shrink-0 text-violet-900 dark:text-violet-100">{chip.text}</span>
        <span className="min-w-0 truncate font-mono text-violet-900 dark:text-violet-100" data-tooltip={anderer.pfad}>{anderer.pfad}</span>
        {hinweis.andere.length > 1 && (
          <span className="shrink-0 text-[10px] text-violet-700 dark:text-violet-300" data-tooltip={hinweis.andere.slice(1).map((m) => m.pfad).join("\n")}>
            +{hinweis.andere.length - 1}
          </span>
        )}
      </div>
      {(entfernen || fassung || behalten || hinweis.art === "exakt") && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {entfernen && (
            <button
              type="button"
              onClick={onEntfernen}
              disabled={laeuft}
              className="kasten kasten-red px-2 py-0.5 text-[11px]"
              data-tooltip={`Diese ZZ-Datei nach ${DOPPEL_QUARANTAENE}/… verschieben (nicht löschen) — die andere bleibt`}
              data-testid="zz-doppel-entfernen"
            >
              {laeuft ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
              Doppel entfernen
            </button>
          )}
          {fassung && (
            <button
              type="button"
              onClick={onFassung}
              disabled={laeuft}
              className="kasten kasten-blue px-2 py-0.5 text-[11px]"
              data-tooltip={fassungTooltip}
              data-testid="zz-doppel-fassung"
            >
              {laeuft ? <Loader2 className="h-3 w-3 animate-spin" /> : <History className="h-3 w-3" />}
              Als neue Fassung ablegen
            </button>
          )}
          {behalten && (
            <button
              type="button"
              onClick={onBehalten}
              disabled={laeuft}
              className="kasten kasten-muted px-2 py-0.5 text-[11px]"
              data-tooltip="Sind verschiedene Dokumente — Hinweis ausblenden"
              data-testid="zz-doppel-behalten"
            >
              <Copy className="h-3 w-3" />
              Beide behalten
            </button>
          )}
          {hinweis.art === "exakt" && <span className="text-[10px] text-violet-800 dark:text-violet-200">Gleiche Bytes — nicht nochmals ablegen.</span>}
        </div>
      )}
    </div>
  );
}
