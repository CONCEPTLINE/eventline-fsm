"use client";

/**
 * Kreditoren — offene Lieferantenrechnungen aus dem Bexio-Spiegel
 * (/4.0/purchase/bills). Gleiches kompaktes Listen-Muster wie OffenePosten
 * (Kopf sticky, Liste scrollt intern), ohne Link (Bexio-Einkauf hat keine
 * stabile Detail-URL), mit Status-Label.
 */

import { Truck } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatChf, formatDateFull } from "@/lib/format";
import { AbschnittFehler, LeerKarte, RasterFeld, type Abschnitt } from "@/components/finanzen/uebersicht";
import { betragMitWaehrung, istFremdwaehrung, LISTEN_KOPF, LISTEN_KOPF_BG } from "@/components/finanzen/offene-posten";
import { BILL_STATUS_LABEL, type KreditorenAntwort, type OffenerKreditor } from "@/lib/finanzen/types";

const GRID = "grid-cols-[minmax(0,1fr)_80px_68px_32px_92px_76px]";

function Zeile({ p }: { p: OffenerKreditor }) {
  const ueberfaellig = p.tage_ueberfaellig > 0;
  const rot = ueberfaellig ? "text-red-600 dark:text-red-400" : "";
  const status = BILL_STATUS_LABEL[p.status] ?? p.status;
  return (
    <div className="relative after:absolute after:bottom-0 after:left-2 after:right-2 after:h-px after:bg-foreground/10 dark:after:bg-foreground/15 last:after:hidden">
      <div className={`row-hover [--row-hover-x:0.125rem] hidden md:grid ${GRID} gap-2 items-center px-2 py-1.5 text-xs`}>
        <span className="font-medium truncate">{p.lieferant}</span>
        <span className="font-mono truncate" data-tooltip={p.datum ? `Rechnung vom ${formatDateFull(p.datum)}` : undefined}>
          {p.document_no ?? <span className="text-muted-foreground/40">—</span>}
        </span>
        <span className={`tabular-nums ${rot || "text-muted-foreground"}`}>{p.faellig ? formatDateFull(p.faellig) : "—"}</span>
        <span className={`tabular-nums text-right ${rot || "text-muted-foreground"}`}>{ueberfaellig ? p.tage_ueberfaellig : "—"}</span>
        <span className="font-mono tabular-nums text-right">
          {betragMitWaehrung(p.betrag_offen, p.waehrung)}
          {p.betrag_offen !== p.betrag_total && (
            <span className="block text-[10px] text-muted-foreground">von {betragMitWaehrung(p.betrag_total, p.waehrung)}</span>
          )}
        </span>
        <span className="text-muted-foreground truncate" data-tooltip={status}>{status}</span>
      </div>
      <div className="row-hover [--row-hover-x:0.125rem] md:hidden flex items-center gap-3 px-2.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{p.lieferant}</p>
          <p className="text-xs text-muted-foreground truncate">
            {p.document_no && <><span className="font-mono">{p.document_no}</span>{" · "}</>}
            <span className={rot}>{p.faellig ? `fällig ${formatDateFull(p.faellig)}` : status}</span>
          </p>
        </div>
        <span className="font-mono tabular-nums text-sm shrink-0">{betragMitWaehrung(p.betrag_offen, p.waehrung)}</span>
      </div>
    </div>
  );
}

const LABEL = "Offene Kreditoren";

export function Kreditoren({ abschnitt, onErneut }: { abschnitt: Abschnitt<KreditorenAntwort>; onErneut: () => void }) {
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
          <EmptyState icon={Truck} title="Keine offenen Kreditoren" description="Alle Lieferantenrechnungen im Spiegel sind bezahlt." />
        </LeerKarte>
      ) : (
        <div className="rounded-xl border bg-card flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto" data-liste="kreditoren">
            <div className={`${LISTEN_KOPF} ${GRID}`} style={LISTEN_KOPF_BG}>
              <span>Lieferant</span>
              <span>Nr</span>
              <span>Fällig</span>
              <span className="text-right">Tage</span>
              <span className="text-right">Betrag</span>
              <span>Status</span>
            </div>
            <div className="p-1">
              {posten.map((p) => <Zeile key={p.bill_id} p={p} />)}
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
