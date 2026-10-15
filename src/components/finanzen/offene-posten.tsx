"use client";

/**
 * OffenePosten — offene Debitoren (Kundenrechnungen) aus dem Bexio-Spiegel.
 * Kompakte Grid-Liste fuer die halbe Raster-Breite (Kopfzeile sticky, Liste
 * scrollt INTERN, Summenzeile fest unten). Rechnungsdatum als Tooltip an der
 * Nummer, Mahnstufe als Pille neben dem Kunden. Mobile-Variante je Zeile.
 * Betraege in Fremdwaehrung mit ISO-Code statt «CHF» und nicht in der Summe.
 */

import { useState } from "react";
import { ExternalLink, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatChf, formatDateFull } from "@/lib/format";
import { AbschnittFehler, LeerKarte, RasterFeld, type Abschnitt } from "@/components/finanzen/uebersicht";
import { BASIS_WAEHRUNG, RECHNUNG_STATUS_LABEL, type OffenePostenAntwort, type OffenerDebitor } from "@/lib/finanzen/types";

const GRID = "grid-cols-[minmax(0,1fr)_80px_68px_32px_92px_20px]";

/** Sticky-Kopf ueber bg-card: deckend, sonst scheinen Zeilen durch. */
export const LISTEN_KOPF_BG = { backgroundColor: "color-mix(in oklab, var(--muted) 35%, var(--card))" } as const;
export const LISTEN_KOPF = "sticky top-0 z-10 hidden md:grid gap-2 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b";

/** Betrag mit Waehrung: CHF via formatChf, Fremdwaehrung mit ISO-Code. */
export function betragMitWaehrung(v: number, waehrung: string | null): string {
  if (waehrung && waehrung !== BASIS_WAEHRUNG) return `${waehrung} ${formatChf(v, { ohnePrefix: true })}`;
  return formatChf(v);
}

export function istFremdwaehrung(waehrung: string | null): boolean {
  return !!waehrung && waehrung !== BASIS_WAEHRUNG;
}

function Mahnstufe({ stufe }: { stufe: number }) {
  if (stufe <= 0) return null;
  return (
    <span className="inline-flex items-center rounded px-1 py-px text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200 shrink-0">
      {stufe}. Mahnung
    </span>
  );
}

function Zeile({ p }: { p: OffenerDebitor }) {
  const ueberfaellig = p.tage_ueberfaellig > 0;
  const rot = ueberfaellig ? "text-red-600 dark:text-red-400" : "";
  // Hover state-driven inline (Tailwind hover: greift hier unzuverlaessig).
  const [linkHover, setLinkHover] = useState(false);
  return (
    <div className="relative after:absolute after:bottom-0 after:left-2 after:right-2 after:h-px after:bg-foreground/10 dark:after:bg-foreground/15 last:after:hidden">
      <div className={`row-hover [--row-hover-x:0.125rem] hidden md:grid ${GRID} gap-2 items-center px-2 py-1.5 text-xs`}>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="font-medium truncate">{p.kunde}</span>
          <Mahnstufe stufe={p.mahnstufe} />
        </span>
        <span className="font-mono truncate" data-tooltip={`Rechnung vom ${formatDateFull(p.datum)} · ${RECHNUNG_STATUS_LABEL[p.status]}`}>{p.document_nr}</span>
        <span className={`tabular-nums ${rot || "text-muted-foreground"}`}>{p.faellig ? formatDateFull(p.faellig) : "—"}</span>
        <span className={`tabular-nums text-right ${rot || "text-muted-foreground"}`}>{ueberfaellig ? p.tage_ueberfaellig : "—"}</span>
        <span className="font-mono tabular-nums text-right">
          {betragMitWaehrung(p.betrag_offen, p.waehrung)}
          {p.betrag_offen !== p.betrag_total && (
            <span className="block text-[10px] text-muted-foreground">von {betragMitWaehrung(p.betrag_total, p.waehrung)}</span>
          )}
        </span>
        <a
          href={p.bexio_url}
          target="_blank"
          rel="noreferrer"
          className="p-0.5 rounded text-muted-foreground/60 justify-self-end transition-colors"
          style={linkHover ? { color: "var(--foreground)", backgroundColor: "var(--muted)" } : undefined}
          onMouseEnter={() => setLinkHover(true)}
          onMouseLeave={() => setLinkHover(false)}
          data-tooltip="In Bexio öffnen"
          data-tooltip-align="end"
          aria-label={`${p.document_nr} in Bexio öffnen`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      <div className="row-hover [--row-hover-x:0.125rem] md:hidden flex items-center gap-3 px-2.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{p.kunde}</p>
          <p className="text-xs text-muted-foreground truncate">
            <span className="font-mono">{p.document_nr}</span>
            {" · "}
            <span className={rot}>{p.faellig ? `fällig ${formatDateFull(p.faellig)}` : RECHNUNG_STATUS_LABEL[p.status]}</span>
          </p>
        </div>
        <span className="font-mono tabular-nums text-sm shrink-0">{betragMitWaehrung(p.betrag_offen, p.waehrung)}</span>
      </div>
    </div>
  );
}

const LABEL = "Offene Debitoren";

export function OffenePosten({ abschnitt, onErneut }: { abschnitt: Abschnitt<OffenePostenAntwort>; onErneut: () => void }) {
  if (abschnitt.status === "laden") {
    return (
      <RasterFeld label={LABEL}>
        <Skeleton className="flex-1 min-h-[160px]" />
      </RasterFeld>
    );
  }
  if (abschnitt.status === "fehler") {
    return (
      <RasterFeld label={LABEL}>
        <AbschnittFehler onErneut={onErneut} />
      </RasterFeld>
    );
  }

  const posten = abschnitt.data.posten;
  const chf = posten.filter((p) => !istFremdwaehrung(p.waehrung));
  const fremd = posten.length - chf.length;
  const summe = chf.reduce((s, p) => s + p.betrag_offen, 0);

  return (
    <RasterFeld label={LABEL} rechts={posten.length > 0 && <span className="text-xs text-muted-foreground tabular-nums shrink-0">{posten.length} offen</span>}>
      {posten.length === 0 ? (
        <LeerKarte>
          <EmptyState icon={Receipt} title="Keine offenen Debitoren" description="Alle Kundenrechnungen im Spiegel sind bezahlt." />
        </LeerKarte>
      ) : (
        <div className="rounded-xl border bg-card flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto" data-liste="debitoren">
            <div className={`${LISTEN_KOPF} ${GRID}`} style={LISTEN_KOPF_BG}>
              <span>Kunde</span>
              <span>Rechnung</span>
              <span>Fällig</span>
              <span className="text-right">Tage</span>
              <span className="text-right">Betrag</span>
              <span aria-hidden />
            </div>
            <div className="p-1">
              {posten.map((p) => <Zeile key={p.rechnung_id} p={p} />)}
            </div>
          </div>
          <div className="border-t bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground tabular-nums shrink-0">
            {posten.length} offen · <span className="font-mono text-foreground">{formatChf(summe)}</span>
            {fremd > 0 && <> (+ {fremd} in Fremdwährung)</>}
          </div>
        </div>
      )}
    </RasterFeld>
  );
}
