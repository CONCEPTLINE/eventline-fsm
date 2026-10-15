"use client";

/**
 * Bankkonten — Salden aus dem gespiegelten Journal (Soll − Haben je Fibu-
 * Konto). Ist das Journal bei Bexio nicht verfuegbar, zeigt der Abschnitt
 * nur den Hinweis; ist es verfuegbar, aber mit Hinweis (unvollstaendig),
 * steht die amber-Box ueber der Liste. IBAN maskiert (erste 4 … letzte 4).
 */

import { AlertCircle, Landmark } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatChf, formatDateFull } from "@/lib/format";
import { AbschnittFehler, SektionsLabel, type Abschnitt } from "@/components/finanzen/uebersicht";
import type { BankkontenAntwort, BankkontoSaldo } from "@/lib/finanzen/types";

const GRID = "grid-cols-[1fr_160px_180px_90px_110px_140px]";

/** "CH93 0076 2011 6238 5295 7" → "CH93…95 7" (erste 4 + … + letzte 4). */
export function maskiereIban(iban: string | null): string {
  if (!iban) return "—";
  const s = iban.replace(/\s+/g, "");
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function HinweisBox({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 flex-wrap rounded-lg bg-amber-50 dark:bg-amber-500/15 border border-amber-200/70 dark:border-amber-500/30 px-2.5 py-1.5">
      <AlertCircle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300 shrink-0" />
      <p className="text-xs text-amber-900 dark:text-amber-100 flex-1 min-w-0">{text}</p>
    </div>
  );
}

function Zeile({ k }: { k: BankkontoSaldo }) {
  const negativ = k.saldo < 0;
  return (
    <div className="relative after:absolute after:bottom-0 after:left-2.5 after:right-2.5 after:h-px after:bg-foreground/10 dark:after:bg-foreground/15 last:after:hidden">
      <div className={`row-hover [--row-hover-x:0.125rem] hidden md:grid ${GRID} gap-4 items-center px-2.5 py-2`}>
        <span className="text-sm font-medium truncate">
          {k.name ?? "—"}
          {k.account_no && <span className="ml-2 font-mono text-[10px] text-muted-foreground">{k.account_no}</span>}
        </span>
        <span className="text-sm text-muted-foreground truncate">{k.bank_name ?? "—"}</span>
        <span className="font-mono text-xs text-muted-foreground">{maskiereIban(k.iban_nr)}</span>
        <span className="text-sm text-muted-foreground tabular-nums text-right">{k.buchungen_anzahl}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{k.letzte_buchung ? formatDateFull(k.letzte_buchung) : "—"}</span>
        <span className={`font-mono tabular-nums text-right text-sm ${negativ ? "text-red-600 dark:text-red-400" : ""}`}>{formatChf(k.saldo)}</span>
      </div>
      <div className="row-hover [--row-hover-x:0.125rem] md:hidden flex items-center gap-3 px-2.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{k.name ?? "—"}</p>
          <p className="text-xs text-muted-foreground truncate">{k.bank_name ?? "—"} · <span className="font-mono">{maskiereIban(k.iban_nr)}</span></p>
        </div>
        <span className={`font-mono tabular-nums text-sm shrink-0 ${negativ ? "text-red-600 dark:text-red-400" : ""}`}>{formatChf(k.saldo)}</span>
      </div>
    </div>
  );
}

export function Bankkonten({ abschnitt, onErneut }: { abschnitt: Abschnitt<BankkontenAntwort>; onErneut: () => void }) {
  if (abschnitt.status === "laden") {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
      </div>
    );
  }
  if (abschnitt.status === "fehler") return <AbschnittFehler onErneut={onErneut} />;

  const d = abschnitt.data;

  return (
    <div className="space-y-2">
      <SektionsLabel>Bankkonten</SektionsLabel>
      {!d.verfuegbar ? (
        <HinweisBox text={`Bexio liefert keinen Saldo; Journal nicht verfügbar.${d.hinweis ? ` ${d.hinweis}` : ""}`} />
      ) : (
        <>
          {d.hinweis && <HinweisBox text={d.hinweis} />}
          {d.konten.length === 0 ? (
            <div className="rounded-xl border border-dashed bg-card">
              <EmptyState icon={Landmark} title="Keine Bankkonten im Spiegel" description="Nach dem nächsten Abgleich erscheinen die Bexio-Bankkonten hier." />
            </div>
          ) : (
            <div className="rounded-xl border bg-card overflow-hidden">
              <div className={`hidden md:grid ${GRID} gap-4 px-4 py-2.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b bg-muted/30`}>
                <span>Konto</span>
                <span>Bank</span>
                <span>IBAN</span>
                <span className="text-right">Buchungen</span>
                <span>Letzte Buchung</span>
                <span className="text-right">Saldo</span>
              </div>
              <div className="p-1.5">
                {d.konten.map((k) => <Zeile key={k.bankkonto_id} k={k} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
