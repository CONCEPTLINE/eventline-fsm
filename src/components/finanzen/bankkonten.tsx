"use client";

/**
 * Bankkonten — Salden aus dem gespiegelten Journal (Soll − Haben je Fibu-
 * Konto). Kompakte zweizeilige Liste fuer die schmale Raster-Spalte (Konto +
 * Bank/IBAN links, Saldo + Buchungen/letzte Buchung rechts), scrollt intern.
 * Ist das Journal nicht verfuegbar, steht EIN Satz (Server-Hinweis, sonst
 * Fallback); ist es verfuegbar mit Hinweis, steht die Leiste ueber der
 * Liste. IBAN maskiert (erste 4 … letzte 4).
 */

import { AlertCircle, Landmark } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatChf, formatDateFull } from "@/lib/format";
import { AbschnittFehler, LeerKarte, RasterFeld, type Abschnitt } from "@/components/finanzen/uebersicht";
import type { BankkontenAntwort, BankkontoSaldo } from "@/lib/finanzen/types";

const FALLBACK_HINWEIS = "Bexio liefert keinen Saldo; Journal nicht verfügbar.";

/** "CH93 0076 2011 6238 5295 7" → "CH93…95 7" (erste 4 + … + letzte 4). */
export function maskiereIban(iban: string | null): string {
  if (!iban) return "—";
  const s = iban.replace(/\s+/g, "");
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function HinweisLeiste({ text }: { text: string }) {
  return (
    // Darf umbrechen: die Zelle hat Platz, der Server-Satz soll ganz lesbar sein.
    <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-500/15 border border-amber-200/70 dark:border-amber-500/30 px-2.5 py-1.5 shrink-0 min-w-0">
      <AlertCircle className="h-3.5 w-3.5 mt-0.5 text-amber-700 dark:text-amber-300 shrink-0" />
      <p className="text-xs text-amber-900 dark:text-amber-100 flex-1 min-w-0">{text}</p>
    </div>
  );
}

function Zeile({ k }: { k: BankkontoSaldo }) {
  const negativ = k.saldo < 0;
  return (
    <div className="relative after:absolute after:bottom-0 after:left-2 after:right-2 after:h-px after:bg-foreground/10 dark:after:bg-foreground/15 last:after:hidden">
      <div className="row-hover [--row-hover-x:0.125rem] flex items-center gap-3 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium truncate">
            {k.name ?? "—"}
            {k.account_no && <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{k.account_no}</span>}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {k.bank_name ?? "—"} · <span className="font-mono">{maskiereIban(k.iban_nr)}</span>
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`font-mono tabular-nums text-xs ${negativ ? "text-red-600 dark:text-red-400" : ""}`}>{formatChf(k.saldo)}</p>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {k.buchungen_anzahl} Buchungen{k.letzte_buchung && <> · {formatDateFull(k.letzte_buchung)}</>}
          </p>
        </div>
      </div>
    </div>
  );
}

const LABEL = "Bankkonten";

export function Bankkonten({ abschnitt, onErneut }: { abschnitt: Abschnitt<BankkontenAntwort>; onErneut: () => void }) {
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

  const d = abschnitt.data;

  if (!d.verfuegbar) {
    return (
      <RasterFeld label={LABEL}>
        <HinweisLeiste text={d.hinweis ?? FALLBACK_HINWEIS} />
      </RasterFeld>
    );
  }

  return (
    <RasterFeld label={LABEL} rechts={d.konten.length > 0 && <span className="text-xs text-muted-foreground tabular-nums shrink-0">{d.konten.length} Konten</span>}>
      {d.hinweis && <HinweisLeiste text={d.hinweis} />}
      {d.konten.length === 0 ? (
        <LeerKarte>
          <EmptyState icon={Landmark} title="Keine Bankkonten im Spiegel" description="Nach dem nächsten Abgleich erscheinen die Bexio-Bankkonten hier." />
        </LeerKarte>
      ) : (
        <div className="rounded-xl border bg-card flex-1 min-h-0 overflow-y-auto" data-liste="bankkonten">
          <div className="p-1">
            {d.konten.map((k) => <Zeile key={k.bankkonto_id} k={k} />)}
          </div>
        </div>
      )}
    </RasterFeld>
  );
}
