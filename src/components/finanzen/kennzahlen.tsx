"use client";

/**
 * Kennzahlen — vier flache Kacheln in einer Reihe: Offene Debitoren · Offene
 * Kreditoren · Umsatz {jahr} · Vorjahr gleicher Zeitraum (mit Differenz in %,
 * wenn Vorjahr > 0). Summen nur CHF; Fremdwaehrungs-Posten werden darunter
 * gezaehlt genannt.
 */

import { Skeleton } from "@/components/ui/skeleton";
import { formatChf, formatDateFull } from "@/lib/format";
import { AbschnittFehler, type Abschnitt } from "@/components/finanzen/uebersicht";
import type { UebersichtAntwort } from "@/lib/finanzen/types";

/** Prozent-Differenz im selben Zahlenformat wie formatChf (de-CH, Punkt als
 *  Dezimaltrenner), mit Vorzeichen: «+12.5 %». */
const PROZENT = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });

function Kachel({ label, wert, unter }: { label: string; wert: string; unter: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2 min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</p>
      <p className="text-lg leading-tight font-semibold font-mono tabular-nums truncate">{wert}</p>
      <p className="text-[11px] text-muted-foreground truncate">{unter}</p>
    </div>
  );
}

function rechnungen(n: number) {
  return `${n} ${n === 1 ? "Rechnung" : "Rechnungen"}`;
}

/** Stichtag minus ein Jahr als "15.10.2025" (stichtag = "YYYY-MM-DD" aus der
 *  Route). 29.2. im Vorjahr ungueltig → "gleicher Stichtag". */
function vorjahrStichtag(jahr: number, stichtag: string): string {
  const iso = `${jahr - 1}${stichtag.slice(4)}`;
  const d = new Date(iso);
  // "2025-02-29" parst JS still als 1.3. — darum Rueckvergleich.
  if (Number.isNaN(d.getTime()) || !d.toISOString().startsWith(iso)) return "gleicher Stichtag";
  return formatDateFull(iso);
}

export function Kennzahlen({ abschnitt, onErneut }: { abschnitt: Abschnitt<UebersichtAntwort>; onErneut: () => void }) {
  if (abschnitt.status === "laden") {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[66px]" />)}
      </div>
    );
  }
  if (abschnitt.status === "fehler") return <AbschnittFehler onErneut={onErneut} />;

  const k = abschnitt.data.kennzahlen;
  const vorjahr = k.umsatz.vorjahr_gleicher_zeitraum_summe;
  const jahr = k.umsatz.jahr_summe;
  const diffProzent = vorjahr > 0 ? ((jahr - vorjahr) / vorjahr) * 100 : null;

  return (
    <div className="min-w-0">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kachel
          label="Offene Debitoren"
          wert={formatChf(k.debitoren.offen_summe, { stellen: 0 })}
          unter={
            <>
              {rechnungen(k.debitoren.offen_anzahl)}
              {k.debitoren.ueberfaellig_anzahl > 0 && (
                <> · <span className="text-red-600 dark:text-red-400">{k.debitoren.ueberfaellig_anzahl} überfällig ({formatChf(k.debitoren.ueberfaellig_summe, { stellen: 0 })})</span></>
              )}
            </>
          }
        />
        <Kachel
          label="Offene Kreditoren"
          wert={formatChf(k.kreditoren.offen_summe, { stellen: 0 })}
          unter={
            <>
              {rechnungen(k.kreditoren.offen_anzahl)}
              {k.kreditoren.ueberfaellig_anzahl > 0 && (
                <> · <span className="text-red-600 dark:text-red-400">{k.kreditoren.ueberfaellig_anzahl} überfällig ({formatChf(k.kreditoren.ueberfaellig_summe, { stellen: 0 })})</span></>
              )}
            </>
          }
        />
        <Kachel
          label={`Umsatz ${k.jahr}`}
          wert={formatChf(jahr, { stellen: 0 })}
          unter="netto, CHF, bis heute"
        />
        <Kachel
          label="Vorjahr gleicher Zeitraum"
          wert={formatChf(vorjahr, { stellen: 0 })}
          unter={
            diffProzent === null ? (
              `1.1. bis ${vorjahrStichtag(k.jahr, k.stichtag)}`
            ) : (
              <span className={diffProzent >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
                {PROZENT.format(diffProzent)} % gegenüber Vorjahr
              </span>
            )
          }
        />
      </div>
      {k.fremdwaehrung_anzahl > 0 && (
        <p className="text-[11px] text-muted-foreground mt-1">
          {k.fremdwaehrung_anzahl} offene Posten in Fremdwährung sind in den Summen nicht enthalten.
        </p>
      )}
    </div>
  );
}
