"use client";

/**
 * Monats-Stundenuebersicht fuer die Lohnabrechnung.
 *
 * Pro Mitarbeiter:
 *   Stempel-Std  ·  Geplante Std  ·  Rapport-Std  ·  Lohn/h  ·  Lohnkosten  ·  Vollkosten
 *
 * Lohnkosten = effektive Stunden × hourly_wage_chf, wobei "effektive" =
 *   rapport_minutes, falls > 0 — sonst stempel_minutes als Fallback.
 *   Diese Konvention macht die Berechnung im Backend (siehe
 *   /api/hr/monthly-stats), so dass UI nur formatiert.
 *
 * Navigation: zwei Pfeil-Buttons oben, Monat als "Mai 2026" mittig.
 * Default = aktueller Monat.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Wallet } from "lucide-react";
import { toast } from "sonner";

interface EmployeeStats {
  profile_id: string;
  full_name: string;
  role: string;
  stempel_minutes: number;
  geplant_minutes: number;
  rapport_minutes: number;
  hourly_wage_chf: number | null;
  employer_costs_chf_per_hour: number | null;
  effective_basis: "rapport" | "stempel";
  lohnkosten_chf: number | null;
  nettolohn_chf: number | null;
  vollkosten_chf: number | null;
  total_deduction_pct: number;
}

const CHF = new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

function todayMonth(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function fmtMonth({ year, month }: { year: number; month: number }): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function fmtMonthLabel({ year, month }: { year: number; month: number }): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function shiftMonth({ year, month }: { year: number; month: number }, delta: number) {
  let m = month + delta;
  let y = year;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1)  { m += 12; y -= 1; }
  return { year: y, month: m };
}

function fmtHours(minutes: number): string {
  if (minutes === 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

export function MonatsstundenTable() {
  const [period, setPeriod] = useState<{ year: number; month: number }>(todayMonth());
  const [data, setData] = useState<EmployeeStats[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: { year: number; month: number }) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/hr/monthly-stats?month=${fmtMonth(p)}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error || "Daten konnten nicht geladen werden");
        setData([]);
        return;
      }
      setData(json.employees as EmployeeStats[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(period); }, [period, load]);

  // Summen-Zeile berechnen
  const totals = data.reduce(
    (acc, r) => {
      acc.stempel += r.stempel_minutes;
      acc.geplant += r.geplant_minutes;
      acc.rapport += r.rapport_minutes;
      acc.lohnkosten += r.lohnkosten_chf ?? 0;
      acc.netto += r.nettolohn_chf ?? 0;
      acc.vollkosten += r.vollkosten_chf ?? 0;
      return acc;
    },
    { stempel: 0, geplant: 0, rapport: 0, lohnkosten: 0, netto: 0, vollkosten: 0 },
  );

  return (
    <div className="space-y-3">
      {/* Header — Monats-Navigation */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Wallet className="h-4 w-4" /> Lohnabrechnung
          </h2>
          <p className="text-xs text-muted-foreground">
            Stunden + Kosten pro Mitarbeiter. Lohnkosten = effektive Stunden × Stundenlohn.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPeriod((p) => shiftMonth(p, -1))}
            className="p-1.5 rounded-lg border border-border hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08]"
            aria-label="Vorheriger Monat"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="min-w-[140px] text-center text-sm font-semibold tabular-nums">
            {fmtMonthLabel(period)}
          </div>
          <button
            type="button"
            onClick={() => setPeriod((p) => shiftMonth(p, 1))}
            className="p-1.5 rounded-lg border border-border hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08]"
            aria-label="Nächster Monat"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Lade …</div>
          ) : data.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Keine Mitarbeiter.</div>
          ) : (
            <div className="divide-y">
              {/* Header-Row (desktop) */}
              <div className="hidden md:grid items-center gap-2 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                style={{ gridTemplateColumns: "minmax(0, 1.4fr) 70px 70px 70px 70px 95px 95px 95px" }}
              >
                <div>Mitarbeiter</div>
                <div className="text-right">Stempel</div>
                <div className="text-right">Geplant</div>
                <div className="text-right">Rapport</div>
                <div className="text-right">Lohn/h</div>
                <div className="text-right">Brutto</div>
                <div className="text-right">Netto</div>
                <div className="text-right">Vollkosten</div>
              </div>
              {data.map((r) => (
                <StatsRow key={r.profile_id} row={r} />
              ))}
              {/* Summen-Zeile */}
              <div className="hidden md:grid items-center gap-2 px-4 py-2.5 text-xs font-semibold bg-foreground/[0.03] dark:bg-foreground/[0.06]"
                style={{ gridTemplateColumns: "minmax(0, 1.4fr) 70px 70px 70px 70px 95px 95px 95px" }}
              >
                <div>Summe ({data.length})</div>
                <div className="text-right tabular-nums">{fmtHours(totals.stempel)}</div>
                <div className="text-right tabular-nums">{fmtHours(totals.geplant)}</div>
                <div className="text-right tabular-nums">{fmtHours(totals.rapport)}</div>
                <div className="text-right tabular-nums">—</div>
                <div className="text-right tabular-nums">CHF {CHF.format(totals.lohnkosten)}</div>
                <div className="text-right tabular-nums">CHF {CHF.format(totals.netto)}</div>
                <div className="text-right tabular-nums">CHF {CHF.format(totals.vollkosten)}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatsRow({ row }: { row: EmployeeStats }) {
  return (
    <div
      className="grid items-center gap-2 px-4 py-2.5 text-sm"
      style={{ gridTemplateColumns: "minmax(0, 1.4fr) 70px 70px 70px 70px 95px 95px 95px" }}
    >
      <div className="min-w-0">
        <div className="font-medium truncate">{row.full_name}</div>
        <div className="text-[11px] text-muted-foreground truncate">{row.role}</div>
      </div>
      <div className="text-right tabular-nums">{fmtHours(row.stempel_minutes)}</div>
      <div className="text-right tabular-nums">{fmtHours(row.geplant_minutes)}</div>
      <div className="text-right tabular-nums">{fmtHours(row.rapport_minutes)}</div>
      <div className="text-right tabular-nums text-muted-foreground">
        {row.hourly_wage_chf != null ? `CHF ${CHF.format(row.hourly_wage_chf)}` : "—"}
      </div>
      <div className="text-right tabular-nums text-muted-foreground"
        data-tooltip={row.effective_basis === "rapport" ? "Basis: Rapport-Stunden" : "Basis: Stempel-Stunden (kein Rapport)"}
      >
        {row.lohnkosten_chf != null ? `CHF ${CHF.format(row.lohnkosten_chf)}` : "—"}
      </div>
      <div className="text-right tabular-nums font-semibold"
        data-tooltip={`Brutto − Abzüge (${row.total_deduction_pct.toFixed(2)}%) = Netto`}
      >
        {row.nettolohn_chf != null ? `CHF ${CHF.format(row.nettolohn_chf)}` : "—"}
      </div>
      <div className="text-right tabular-nums text-muted-foreground">
        {row.vollkosten_chf != null ? `CHF ${CHF.format(row.vollkosten_chf)}` : "—"}
      </div>
    </div>
  );
}
