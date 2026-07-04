"use client";

/**
 * Jahres-Lohnsummen-Prognose fuer Ausgleichskasse / SUVA / BVG-Meldung.
 *
 * Kombiniert IST YTD (echte Stempelzeiten × Lohn + Zuschlaege) mit einer
 * Prognose fuer den Rest des Jahres (geplante Termine + Location-
 * Historien-Schaetzung fuer noch nicht angelegte Termine).
 *
 * Datenquelle: /api/hr/monthly-stats?month=YYYY-MM — dieselbe API die
 * die HR-Lohntabelle liefert. Wir picken hier nur das annualPayrollSummary-
 * Feld raus.
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, TrendingUp } from "lucide-react";
import { Loading } from "@/components/ui/spinner";
import { toast } from "sonner";

interface AnnualMonth {
  month: number;
  label: string;
  kind: "past" | "current" | "future";
  plan_minutes: number;
  brutto_chf: number;
  netto_chf: number;
  vollkosten_chf: number;
  history_additional_minutes?: number;
  history_additional_brutto_chf?: number;
}

interface AnnualPayrollSummary {
  year: number;
  ytd_actual_brutto_chf: number;
  current_month_forecast_chf: number;
  rest_of_year_forecast_chf: number;
  total_year_brutto_chf: number;
  total_year_netto_chf: number;
  total_year_vollkosten_chf: number;
  monthly: AnnualMonth[];
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

export function LohnsummenPrognose() {
  const [period, setPeriod] = useState<{ year: number; month: number }>(todayMonth());
  const [annualSummary, setAnnualSummary] = useState<AnnualPayrollSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/hr/monthly-stats?month=${fmtMonth(period)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) {
          toast.error(json.error || "Daten konnten nicht geladen werden");
          setAnnualSummary(null);
          return;
        }
        setAnnualSummary(json.annualPayrollSummary ?? null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  return (
    <div className="space-y-3">
      {/* Jahres-Navigation */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            Jahres-Lohnsumme
          </h2>
          <p className="text-xs text-muted-foreground">
            Für Ausgleichskasse, SUVA, BVG-Meldung. Basiert auf ausgewähltem Referenz-Monat (bestimmt IST vs. Prognose-Split).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setPeriod((p) => shiftMonth(p, -1))}
            className="p-1.5 rounded-lg border border-border hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.08]"
            aria-label="Vorheriger Monat"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="min-w-[140px] text-center text-sm font-semibold tabular-nums">
            {MONTH_NAMES[period.month - 1]} {period.year}
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

      {loading ? (
        <Loading />
      ) : !annualSummary || annualSummary.total_year_brutto_chf === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            Keine Daten für dieses Jahr.
          </CardContent>
        </Card>
      ) : (
        <Card className="border-blue-500/30 bg-blue-500/[0.02] dark:bg-blue-500/[0.04]">
          <CardContent className="p-0">
            <div className="px-4 py-4 border-b border-border">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold flex items-center gap-2 whitespace-nowrap">
                    <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
                    Jahres-Lohnsumme {annualSummary.year}
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    IST YTD + Prognose Rest-des-Jahres (geplante Termine + Location-Historien-Schätzung für noch nicht angelegte). Inkl. Nacht-/Sonntag-Zuschlägen (ArG).
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground whitespace-nowrap">Brutto-Lohnsumme Jahr</p>
                  <p className="text-2xl font-bold tabular-nums text-blue-700 dark:text-blue-300 whitespace-nowrap">CHF {CHF.format(annualSummary.total_year_brutto_chf)}</p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <div className="px-3 py-2 rounded-lg bg-foreground/[0.03] dark:bg-foreground/[0.06] min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis">IST YTD (Jan–{MONTH_NAMES[period.month - 2] ?? "—"})</p>
                  <p className="font-semibold tabular-nums whitespace-nowrap">CHF {CHF.format(annualSummary.ytd_actual_brutto_chf)}</p>
                </div>
                <div className="px-3 py-2 rounded-lg bg-foreground/[0.03] dark:bg-foreground/[0.06] min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis">Laufend ({MONTH_NAMES[period.month - 1]})</p>
                  <p className="font-semibold tabular-nums whitespace-nowrap">CHF {CHF.format(annualSummary.current_month_forecast_chf)}</p>
                </div>
                <div className="px-3 py-2 rounded-lg bg-foreground/[0.03] dark:bg-foreground/[0.06] min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground whitespace-nowrap">Prognose Rest</p>
                  <p className="font-semibold tabular-nums whitespace-nowrap">CHF {CHF.format(annualSummary.rest_of_year_forecast_chf)}</p>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div className="px-3 py-2 rounded-lg bg-emerald-500/5 border border-emerald-500/20 min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground whitespace-nowrap overflow-hidden text-ellipsis">Auszahlung Jahr (Netto)</p>
                  <p className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300 whitespace-nowrap">CHF {CHF.format(annualSummary.total_year_netto_chf)}</p>
                </div>
                <div className="px-3 py-2 rounded-lg bg-foreground/[0.03] dark:bg-foreground/[0.06] min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground whitespace-nowrap">Vollkosten Firma</p>
                  <p className="font-semibold tabular-nums whitespace-nowrap">CHF {CHF.format(annualSummary.total_year_vollkosten_chf)}</p>
                </div>
              </div>
            </div>

            {/* 12-Monats-Breakdown */}
            <div className="hidden md:grid items-center gap-x-2 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border"
              style={{ gridTemplateColumns: "minmax(0, 1fr) 90px 85px 120px 130px 120px" }}
            >
              <div>Monat</div>
              <div className="text-center" data-tooltip="Ist = tatsächlich gearbeitet · Prognose = geplant + Historie">Typ</div>
              <div className="text-right border-l border-border pl-2">Stunden</div>
              <div className="text-right">Brutto</div>
              <div className="text-right text-emerald-700 dark:text-emerald-300 font-semibold">Auszahlung</div>
              <div className="text-right">Vollkosten</div>
            </div>
            {annualSummary.monthly.map((m) => {
              const histMin = m.history_additional_minutes ?? 0;
              const histChf = m.history_additional_brutto_chf ?? 0;
              const showSplit = (m.kind === "future" || m.kind === "current") && histMin > 0;
              const plannedMin = Math.max(0, m.plan_minutes - histMin);
              const plannedChf = Math.max(0, m.brutto_chf - histChf);
              const tooltip = showSplit
                ? `Davon geplant: ${fmtHours(plannedMin)} · CHF ${CHF.format(plannedChf)}\nHistorien-Schätzung für noch nicht angelegte Termine: ${fmtHours(histMin)} · CHF ${CHF.format(histChf)}`
                : undefined;
              return (
                <div
                  key={m.month}
                  className={`hidden md:grid items-center gap-x-2 px-4 py-2 text-sm border-b border-border/40 last:border-0 ${
                    m.kind === "current" ? "bg-blue-500/[0.06] dark:bg-blue-500/[0.10] font-medium" : ""
                  } ${m.kind === "past" ? "text-muted-foreground/85" : ""}`}
                  style={{ gridTemplateColumns: "minmax(0, 1fr) 90px 85px 120px 130px 120px" }}
                >
                  <div className="flex items-center gap-1.5">
                    <span>{m.label} {annualSummary.year}</span>
                    {showSplit && (
                      <span
                        className="text-[9px] uppercase px-1 py-0.5 rounded bg-purple-500/15 text-purple-700 dark:text-purple-300 whitespace-nowrap cursor-help"
                        data-tooltip={tooltip}
                      >
                        + Historie
                      </span>
                    )}
                  </div>
                  <div className="text-center">
                    {m.kind === "past" && <span className="inline-block text-[9px] uppercase px-1.5 py-0.5 rounded bg-foreground/10 text-muted-foreground whitespace-nowrap">Ist</span>}
                    {m.kind === "current" && <span className="inline-block text-[9px] uppercase px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-700 dark:text-blue-300 whitespace-nowrap">laufend</span>}
                    {m.kind === "future" && <span className="inline-block text-[9px] uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 whitespace-nowrap">Prognose</span>}
                  </div>
                  <div className="text-right tabular-nums border-l border-border pl-2">{fmtHours(m.plan_minutes)}</div>
                  <div className="text-right tabular-nums" data-tooltip={tooltip}>CHF {CHF.format(m.brutto_chf)}</div>
                  <div className="text-right tabular-nums text-emerald-700 dark:text-emerald-300 font-semibold">CHF {CHF.format(m.netto_chf)}</div>
                  <div className="text-right tabular-nums text-muted-foreground">CHF {CHF.format(m.vollkosten_chf)}</div>
                </div>
              );
            })}
            {/* Mobile-Cards */}
            <div className="md:hidden divide-y">
              {annualSummary.monthly.map((m) => (
                <div key={m.month} className={`px-4 py-2.5 ${m.kind === "current" ? "bg-blue-500/[0.06]" : ""} ${m.kind === "past" ? "opacity-75" : ""}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">{m.label}</span>
                    {m.kind === "past" && <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-foreground/10 text-muted-foreground">Ist</span>}
                    {m.kind === "current" && <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-blue-500/20 text-blue-700 dark:text-blue-300">laufend</span>}
                    {m.kind === "future" && <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300">Prognose</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-y-0.5 text-xs">
                    <span className="text-muted-foreground">Brutto</span>
                    <span className="text-right tabular-nums">CHF {CHF.format(m.brutto_chf)}</span>
                    <span className="text-muted-foreground">Auszahlung</span>
                    <span className="text-right tabular-nums text-emerald-700 dark:text-emerald-300">CHF {CHF.format(m.netto_chf)}</span>
                    <span className="text-muted-foreground">Vollkosten</span>
                    <span className="text-right tabular-nums">CHF {CHF.format(m.vollkosten_chf)}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
