"use client";

/**
 * Kreditoren — offene Lieferantenrechnungen aus dem Bexio-Spiegel
 * (/4.0/purchase/bills). Gleiches Listen-Muster wie OffenePosten, ohne Link
 * (Bexio-Einkauf hat keine stabile Detail-URL), mit Status-Label.
 */

import { Truck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatChf, formatDateFull } from "@/lib/format";
import { AbschnittFehler, SektionsLabel, type Abschnitt } from "@/components/finanzen/uebersicht";
import { betragMitWaehrung, istFremdwaehrung } from "@/components/finanzen/offene-posten";
import { BILL_STATUS_LABEL, type KreditorenAntwort, type OffenerKreditor } from "@/lib/finanzen/types";

const GRID = "grid-cols-[1fr_120px_96px_96px_72px_120px_140px]";

function Zeile({ p }: { p: OffenerKreditor }) {
  const ueberfaellig = p.tage_ueberfaellig > 0;
  const rot = ueberfaellig ? "text-red-600 dark:text-red-400" : "";
  return (
    <div className="relative after:absolute after:bottom-0 after:left-2.5 after:right-2.5 after:h-px after:bg-foreground/10 dark:after:bg-foreground/15 last:after:hidden">
      <div className={`row-hover [--row-hover-x:0.125rem] hidden md:grid ${GRID} gap-4 items-center px-2.5 py-2`}>
        <span className="text-sm font-medium truncate">{p.lieferant}</span>
        <span className="font-mono text-xs truncate">{p.document_no ?? <span className="text-muted-foreground/40">—</span>}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{p.datum ? formatDateFull(p.datum) : "—"}</span>
        <span className={`text-sm tabular-nums ${rot || "text-muted-foreground"}`}>{p.faellig ? formatDateFull(p.faellig) : "—"}</span>
        <span className={`text-sm tabular-nums text-right ${rot || "text-muted-foreground"}`}>{ueberfaellig ? p.tage_ueberfaellig : "—"}</span>
        <span className="font-mono tabular-nums text-right text-sm">
          {betragMitWaehrung(p.betrag_offen, p.waehrung)}
          {p.betrag_offen !== p.betrag_total && (
            <span className="block text-[10px] text-muted-foreground">von {betragMitWaehrung(p.betrag_total, p.waehrung)}</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground truncate">{BILL_STATUS_LABEL[p.status] ?? p.status}</span>
      </div>
      <div className="row-hover [--row-hover-x:0.125rem] md:hidden flex items-center gap-3 px-2.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{p.lieferant}</p>
          <p className="text-xs text-muted-foreground truncate">
            {p.document_no && <><span className="font-mono">{p.document_no}</span>{" · "}</>}
            <span className={rot}>{p.faellig ? `fällig ${formatDateFull(p.faellig)}` : (BILL_STATUS_LABEL[p.status] ?? p.status)}</span>
          </p>
        </div>
        <span className="font-mono tabular-nums text-sm shrink-0">{betragMitWaehrung(p.betrag_offen, p.waehrung)}</span>
      </div>
    </div>
  );
}

export function Kreditoren({ abschnitt, onErneut }: { abschnitt: Abschnitt<KreditorenAntwort>; onErneut: () => void }) {
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
        Offene Kreditoren
      </SektionsLabel>
      {posten.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card">
          <EmptyState icon={Truck} title="Keine offenen Kreditoren" description="Alle Lieferantenrechnungen im Spiegel sind bezahlt." />
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className={`hidden md:grid ${GRID} gap-4 px-4 py-2.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b bg-muted/30`}>
            <span>Lieferant</span>
            <span>Nr</span>
            <span>Datum</span>
            <span>Fällig</span>
            <span className="text-right">Tage</span>
            <span className="text-right">Betrag</span>
            <span>Status</span>
          </div>
          <div className="p-1.5">
            {posten.map((p) => <Zeile key={p.bill_id} p={p} />)}
          </div>
          <div className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground tabular-nums">
            {posten.length} offen · <span className="font-mono text-foreground">{formatChf(summe)}</span>
            {fremd > 0 && <> (+ {fremd} in Fremdwährung)</>}
          </div>
        </div>
      )}
    </div>
  );
}
