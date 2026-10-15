"use client";

/**
 * OffenePosten — offene Debitoren (Kundenrechnungen) aus dem Bexio-Spiegel.
 * Grid-Liste nach Muster kunden-view (Kopfzeile + row-hover-Zeilen),
 * Mobile-Variante je Zeile, Summenzeile unten. Betraege in Fremdwaehrung
 * mit ISO-Code statt «CHF» und nicht in der Summe.
 */

import { useState } from "react";
import { ExternalLink, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatChf, formatDateFull } from "@/lib/format";
import { AbschnittFehler, SektionsLabel, type Abschnitt } from "@/components/finanzen/uebersicht";
import { BASIS_WAEHRUNG, RECHNUNG_STATUS_LABEL, type OffenePostenAntwort, type OffenerDebitor } from "@/lib/finanzen/types";

const GRID = "grid-cols-[1fr_120px_96px_96px_72px_120px_80px_32px]";

/** Betrag mit Waehrung: CHF via formatChf, Fremdwaehrung mit ISO-Code. */
export function betragMitWaehrung(v: number, waehrung: string | null): string {
  if (waehrung && waehrung !== BASIS_WAEHRUNG) return `${waehrung} ${formatChf(v, { ohnePrefix: true })}`;
  return formatChf(v);
}

export function istFremdwaehrung(waehrung: string | null): boolean {
  return !!waehrung && waehrung !== BASIS_WAEHRUNG;
}

function Mahnstufe({ stufe }: { stufe: number }) {
  if (stufe <= 0) return <span className="text-muted-foreground/40">—</span>;
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
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
    <div className="relative after:absolute after:bottom-0 after:left-2.5 after:right-2.5 after:h-px after:bg-foreground/10 dark:after:bg-foreground/15 last:after:hidden">
      <div className={`row-hover [--row-hover-x:0.125rem] hidden md:grid ${GRID} gap-4 items-center px-2.5 py-2`}>
        <span className="text-sm font-medium truncate">{p.kunde}</span>
        <span className="font-mono text-xs truncate">{p.document_nr}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{formatDateFull(p.datum)}</span>
        <span className={`text-sm tabular-nums ${rot || "text-muted-foreground"}`}>{p.faellig ? formatDateFull(p.faellig) : "—"}</span>
        <span className={`text-sm tabular-nums text-right ${rot || "text-muted-foreground"}`}>{ueberfaellig ? p.tage_ueberfaellig : "—"}</span>
        <span className="font-mono tabular-nums text-right text-sm">
          {betragMitWaehrung(p.betrag_offen, p.waehrung)}
          {p.betrag_offen !== p.betrag_total && (
            <span className="block text-[10px] text-muted-foreground">von {betragMitWaehrung(p.betrag_total, p.waehrung)}</span>
          )}
        </span>
        <span><Mahnstufe stufe={p.mahnstufe} /></span>
        <a
          href={p.bexio_url}
          target="_blank"
          rel="noreferrer"
          className="p-1 rounded text-muted-foreground/60 justify-self-end transition-colors"
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

export function OffenePosten({ abschnitt, onErneut }: { abschnitt: Abschnitt<OffenePostenAntwort>; onErneut: () => void }) {
  if (abschnitt.status === "laden") {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
      </div>
    );
  }
  if (abschnitt.status === "fehler") return <AbschnittFehler onErneut={onErneut} />;

  const posten = abschnitt.data.posten;
  const chf = posten.filter((p) => !istFremdwaehrung(p.waehrung));
  const fremd = posten.length - chf.length;
  const summe = chf.reduce((s, p) => s + p.betrag_offen, 0);

  return (
    <div className="space-y-2">
      <SektionsLabel rechts={posten.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{posten.length} offen</span>}>
        Offene Debitoren
      </SektionsLabel>
      {posten.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card">
          <EmptyState icon={Receipt} title="Keine offenen Debitoren" description="Alle Kundenrechnungen im Spiegel sind bezahlt." />
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className={`hidden md:grid ${GRID} gap-4 px-4 py-2.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b bg-muted/30`}>
            <span>Kunde</span>
            <span>Rechnung</span>
            <span>Datum</span>
            <span>Fällig</span>
            <span className="text-right">Tage</span>
            <span className="text-right">Betrag</span>
            <span>Mahnstufe</span>
            <span aria-hidden />
          </div>
          <div className="p-1.5">
            {posten.map((p) => <Zeile key={p.rechnung_id} p={p} />)}
          </div>
          <div className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground flex items-center justify-between gap-3 flex-wrap">
            <span className="tabular-nums">
              {posten.length} offen · <span className="font-mono text-foreground">{formatChf(summe)}</span>
              {fremd > 0 && <> (+ {fremd} in Fremdwährung)</>}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
