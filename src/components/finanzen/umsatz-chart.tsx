"use client";

/**
 * UmsatzChart — Balken pro Monat, laufendes Jahr neben Vorjahr (recharts).
 * Farben ueber CSS-Variablen (--chart-1 = Marke, --chart-3 = neutral), damit
 * hell/dunkel ohne eigene Logik stimmt. Legende als zwei Chips ueber dem
 * Diagramm (keine recharts-Legend), Tooltip in Karten-Optik mit formatChf.
 * Reihenfolge in der Gruppe ist fest (Jahr links, Vorjahr rechts) — das ist
 * die zweite Kodierung neben der Farbe.
 */

import { useMemo } from "react";
import { BarChart3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { formatChf } from "@/lib/format";
import { AbschnittFehler, SektionsLabel, type Abschnitt } from "@/components/finanzen/uebersicht";
import type { UmsatzAntwort, UmsatzMonat } from "@/lib/finanzen/types";

const MONAT_FORMAT = new Intl.DateTimeFormat("de-CH", { month: "short", timeZone: "Europe/Zurich" });

interface Punkt extends UmsatzMonat {
  label: string;
}

/** Eigener Tooltip-Inhalt: Karte, Werte mit formatChf, Text in Text-Tokens. */
function TooltipInhalt({
  active,
  payload,
  label,
  jahr,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown }>;
  label?: unknown;
  jahr: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const wert = (key: string) => {
    const p = payload.find((x) => x.dataKey === key);
    return formatChf(typeof p?.value === "number" || typeof p?.value === "string" ? p.value : 0);
  };
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow">
      <p className="font-medium mb-1">{typeof label === "string" || typeof label === "number" ? label : ""} {jahr}</p>
      <div className="space-y-0.5 font-mono tabular-nums">
        <p className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--chart-1)" }} />
          <span className="text-muted-foreground">{jahr}</span>
          <span className="ml-auto">{wert("umsatz")}</span>
        </p>
        <p className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--chart-3)" }} />
          <span className="text-muted-foreground">{jahr - 1}</span>
          <span className="ml-auto">{wert("umsatz_vorjahr")}</span>
        </p>
      </div>
    </div>
  );
}

function Chip({ farbe, text }: { farbe: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: farbe }} />
      {text}
    </span>
  );
}

export function UmsatzChart({ abschnitt, onErneut }: { abschnitt: Abschnitt<UmsatzAntwort>; onErneut: () => void }) {
  const daten = abschnitt.status === "daten" ? abschnitt.data : null;
  const punkte = useMemo<Punkt[]>(() => {
    if (!daten) return [];
    return daten.monate.map((m) => ({
      ...m,
      // Monatskuerzel aus einem Datum in der Monatsmitte (zeitzonenfest).
      label: MONAT_FORMAT.format(new Date(Date.UTC(daten.jahr, m.monat - 1, 15))).replace(".", ""),
    }));
  }, [daten]);

  if (abschnitt.status === "laden") return <Skeleton className="h-64" />;
  if (abschnitt.status === "fehler" || !daten) return <AbschnittFehler onErneut={onErneut} />;

  const alleNull = punkte.every((p) => p.umsatz === 0 && p.umsatz_vorjahr === 0);

  return (
    <div className="space-y-2">
      <SektionsLabel
        rechts={
          !alleNull && (
            <span className="flex items-center gap-3">
              <Chip farbe="var(--chart-1)" text={String(daten.jahr)} />
              <Chip farbe="var(--chart-3)" text={String(daten.jahr - 1)} />
            </span>
          )
        }
      >
        Umsatz pro Monat — netto, CHF, ohne Gutschriften
      </SektionsLabel>
      <div className="rounded-xl border bg-card px-2 py-3">
        {alleNull ? (
          <EmptyState
            icon={BarChart3}
            title="Noch keine Umsätze im Spiegel"
            description="Nach dem ersten Abgleich erscheinen hier die Monate."
          />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={punkte} barGap={2} barCategoryGap="28%">
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                width={72}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => formatChf(v, { stellen: 0, ohnePrefix: true })}
              />
              <Tooltip
                cursor={{ fill: "color-mix(in oklab, var(--foreground) 6%, transparent)" }}
                content={(p) => <TooltipInhalt active={p.active} payload={p.payload} label={p.label} jahr={daten.jahr} />}
              />
              <Bar dataKey="umsatz" name={String(daten.jahr)} fill="var(--chart-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="umsatz_vorjahr" name={String(daten.jahr - 1)} fill="var(--chart-3)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
