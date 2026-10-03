"use client";

// Kopf des Dashboards: Datum, Gruss und ein Satz, der sagt, wie der Tag
// steht — rechts daneben die Kennzahlen als Pillen.

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DashboardDaten } from "@/components/dashboard/typen";
import { aufmerksamkeitZeilen } from "@/components/dashboard/aufmerksamkeit-karte";
import { hochgezaehlt } from "@/components/dashboard/use-auftakt";
import { datumLang, einsatzTagImSatz, gruss, uhrzeit, zahlwort } from "@/components/dashboard/format";

type Satz = { text: string; ton: "ruhig" | "rot" | "amber" | "einsatz" };

/** Der Status-Satz unter dem Gruss. null = Rolle sieht weder Aufmerksamkeit
 *  noch Einsatz — dann bleibt es beim Gruss. */
export function kopfSatz(d: DashboardDaten): Satz | null {
  if (d.aufmerksamkeit) {
    // Nur sichtbare Zeilen zaehlen — nicht gelieferte (Recht fehlt) sind null.
    const n = aufmerksamkeitZeilen(d.aufmerksamkeit).length;
    const k = d.aufmerksamkeit.ueberfaellig?.anzahl ?? 0;
    if (n === 0) return { text: "Alles im grünen Bereich. Nichts wartet auf dich.", ton: "ruhig" };
    let text = n === 1 ? "Eine Sache wartet auf dich." : `${zahlwort(n)} Dinge warten auf dich.`;
    text += k === 0 ? " Der Rest läuft." : k === 1 ? " Ein Auftrag ist überfällig." : ` ${zahlwort(k)} Aufträge sind überfällig.`;
    return { text, ton: k > 0 ? "rot" : "amber" };
  }
  if (d.einsatz) {
    const e = d.einsatz.naechster;
    if (!e) return { text: "Ruhige Tage. Kein Einsatz in Sicht.", ton: "ruhig" };
    return {
      text: `Dein nächster Einsatz: ${einsatzTagImSatz(e.start)} um ${uhrzeit(e.start)}${e.ort ? ` im ${e.ort}` : ""}.`,
      ton: "einsatz",
    };
  }
  return null;
}

const SATZ_KREIS: Record<Satz["ton"], string> = {
  ruhig: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  rot: "bg-red-500/10 dark:bg-red-500/20",
  amber: "bg-amber-500/15 dark:bg-amber-500/20",
  einsatz: "bg-emerald-500/10 dark:bg-emerald-500/20",
};
const SATZ_PUNKT: Record<Exclude<Satz["ton"], "ruhig">, string> = {
  rot: "bg-accent",
  amber: "bg-amber-500",
  einsatz: "bg-emerald-500",
};

export function DashboardKopf({ daten, anteil }: { daten: DashboardDaten; anteil: number }) {
  const jetzt = new Date();
  const satz = kopfSatz(daten);
  const k = daten.kennzahlen;
  const pillen: { key: string; wert: number; label: string; href: string }[] = [];
  if (k?.offene_auftraege != null) {
    pillen.push({
      key: "auftraege",
      wert: k.offene_auftraege,
      label: k.offene_auftraege === 1 ? "offener Auftrag" : "offene Aufträge",
      href: "/auftraege?segment=aktiv&from=dashboard",
    });
  }
  if (k?.termine_7_tage != null) {
    pillen.push({
      key: "termine",
      wert: k.termine_7_tage,
      label: k.termine_7_tage === 1 ? "Termin in 7 Tagen" : "Termine in 7 Tagen",
      href: "/kalender?from=dashboard",
    });
  }

  return (
    <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
      <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-2.5">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{datumLang(jetzt)}</p>
        <h1 className="font-heading text-[2rem] font-bold leading-[1.15] tracking-[-0.01em]">
          {gruss(jetzt)}
          {daten.vorname ? `, ${daten.vorname}` : ""}
        </h1>
        {satz && (
          <p className="flex items-center gap-2.5 text-base text-foreground/80">
            <span className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full", SATZ_KREIS[satz.ton])}>
              {satz.ton === "ruhig" ? (
                <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
              ) : (
                <span className={cn("h-2 w-2 rounded-full", SATZ_PUNKT[satz.ton])} />
              )}
            </span>
            <span>{satz.text}</span>
          </p>
        )}
      </div>
      {pillen.length > 0 && (
        <nav aria-label="Kennzahlen" className="flex flex-wrap gap-2">
          {pillen.map((p) => (
            <KennzahlPille key={p.key} wert={hochgezaehlt(p.wert, anteil)} label={p.label} href={p.href} />
          ))}
        </nav>
      )}
    </header>
  );
}

function KennzahlPille({ wert, label, href }: { wert: number; label: string; href: string }) {
  const [hover, setHover] = useState(false);
  return (
    <Link
      href={href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-baseline gap-2 whitespace-nowrap rounded-full border bg-card px-4 py-2 text-sm"
      style={{
        // Hover state-driven (Projekt-Regel), gleiche Staerke wie JobNumber.
        borderColor: hover ? "color-mix(in srgb, var(--foreground) 35%, transparent)" : undefined,
        background: hover ? "color-mix(in srgb, var(--foreground) 6%, var(--card))" : undefined,
        transition: "border-color 120ms, background-color 120ms",
      }}
    >
      <b className="font-heading text-lg font-bold tabular-nums">{wert}</b>
      <span className="text-muted-foreground">{label}</span>
    </Link>
  );
}
