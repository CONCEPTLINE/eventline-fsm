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

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Wallet, Shield, Download, TrendingUp } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loading } from "@/components/ui/spinner";
import { EmployeeWageDetailModal } from "@/components/hr/employee-wage-detail-modal";

interface EmployeeStats {
  profile_id: string;
  full_name: string;
  role: string;
  is_active: boolean;
  stempel_minutes: number;
  geplant_minutes: number;
  rapport_minutes: number;
  hourly_wage_chf: number | null;
  employer_costs_chf_per_hour: number | null;
  effective_basis: "stempel";
  base_lohnkosten_chf: number | null;
  lohnkosten_chf: number | null;
  nettolohn_chf: number | null;
  vollkosten_chf: number | null;
  total_deduction_pct: number;
  night_surcharge_chf: number;
  sunhol_surcharge_chf: number;
  total_surcharge_chf: number;
  night_eligible_minutes: number;
  sunhol_eligible_minutes: number;
  night_over_limit: boolean;
  sunhol_over_limit: boolean;
  /** 3-Monats-BVG-Forecast aus geplanten Terminen: [Mo, +1, +2] in CHF. */
  bvg_forecast_3_months_chf: number[];
  /** Zeitkomp diesen Monat erworben (10% der Nachtmin >24/Jahr, ArG 17b). */
  night_time_comp_minutes_this_month: number;
  /** Kumuliert YTD. */
  ytd_night_time_comp_minutes: number;
  night_shifts_over_limit_this_month: number;
  ytd_night_shifts_total: number;
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

interface PayrollForecastMonth {
  label: string;
  is_current_month: boolean;
  plan_minutes: number;
  brutto_chf: number;
  netto_chf: number;
  vollkosten_chf: number;
}

export function MonatsstundenTable() {
  const [period, setPeriod] = useState<{ year: number; month: number }>(todayMonth());
  const [data, setData] = useState<EmployeeStats[]>([]);
  const [payrollForecast, setPayrollForecast] = useState<PayrollForecastMonth[]>([]);
  const [bvgThreshold, setBvgThreshold] = useState<number>(1890);
  // Monats-Labels fuer die 3 BVG-Forecast-Spalten (z.B. ["Juni 2026", "Juli 2026", "August 2026"]).
  const [bvgMonthLabels, setBvgMonthLabels] = useState<string[]>(["", "", ""]);
  const [loading, setLoading] = useState(true);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  // Timesheet-Excel-Export: Default = aktueller Monat, optional Custom-Range.
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const monthStartIso = `${period.year}-${String(period.month).padStart(2, "0")}-01`;
  const monthEndIso = (() => {
    const lastDay = new Date(period.year, period.month, 0).getDate();
    return `${period.year}-${String(period.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  })();
  const [exportFrom, setExportFrom] = useState(monthStartIso);
  const [exportTo, setExportTo] = useState(monthEndIso);

  async function downloadTimesheet(from: string, to: string) {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/hr/timesheet?from=${from}&to=${to}`);
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        toast.error(j?.error || "Export fehlgeschlagen");
        return;
      }
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `eventline-timesheet_${from}_${to}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      setExportOpen(false);
    } finally {
      setExporting(false);
    }
  }
  // Toggle "Nur mit Stunden" — verbergt Mitarbeiter ohne Stempel/Geplant/
  // Rapport-Minuten (zeigen sonst nur Dashes, wirken wie Bug). Default an.
  const [onlyWithHours, setOnlyWithHours] = useState(true);

  // Cancel-Token: bei rapidem Monatswechsel verwerfen wir Stale-Fetches
  // damit das Result vom letzten Klick gewinnt (nicht der schnellere
  // frueheren Request).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/hr/monthly-stats?month=${fmtMonth(period)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) {
          toast.error(json.error || "Daten konnten nicht geladen werden");
          setData([]);
          return;
        }
        setData(json.employees as EmployeeStats[]);
        if (typeof json.bvgThresholdChf === "number") setBvgThreshold(json.bvgThresholdChf);
        if (Array.isArray(json.bvgForecastMonthLabels)) setBvgMonthLabels(json.bvgForecastMonthLabels);
        setPayrollForecast(Array.isArray(json.payrollForecast) ? json.payrollForecast : []);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  // Optional gefiltert (nur Zeilen mit Aktivitaet im Monat)
  const visibleData = onlyWithHours
    ? data.filter((r) => r.stempel_minutes > 0 || r.geplant_minutes > 0 || r.rapport_minutes > 0)
    : data;
  const hiddenCount = data.length - visibleData.length;

  // Summen-Zeile berechnen
  const totals = visibleData.reduce(
    (acc, r) => {
      acc.stempel += r.stempel_minutes;
      acc.geplant += r.geplant_minutes;
      acc.rapport += r.rapport_minutes;
      acc.surcharge += r.total_surcharge_chf;
      acc.lohnkosten += r.lohnkosten_chf ?? 0;
      acc.netto += r.nettolohn_chf ?? 0;
      acc.vollkosten += r.vollkosten_chf ?? 0;
      return acc;
    },
    { stempel: 0, geplant: 0, rapport: 0, surcharge: 0, lohnkosten: 0, netto: 0, vollkosten: 0 },
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
            Auszahlung pro Mitarbeiter — inkl. Nacht-/Sonntags-Zuschläge nach Schweizer ArG. Klick auf einen Namen für Details.
            <span className="ml-2 inline-flex items-center gap-1 text-muted-foreground/80">
              <Shield className="h-3 w-3" />BVG-Schwelle {CHF.format(bvgThreshold)} CHF/Monat
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={onlyWithHours}
              onChange={(e) => setOnlyWithHours(e.target.checked)}
              className="accent-red-500"
            />
            Nur mit Stunden{hiddenCount > 0 ? ` (${hiddenCount} ausgeblendet)` : ""}
          </label>
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
          <button
            type="button"
            onClick={() => {
              setExportFrom(monthStartIso);
              setExportTo(monthEndIso);
              setExportOpen(true);
            }}
            className="kasten kasten-muted text-xs"
            data-tooltip="Timesheet als Excel herunterladen"
          >
            <Download className="h-3.5 w-3.5" />
            Excel
          </button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <Loading />
          ) : visibleData.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Keine Mitarbeiter.</div>
          ) : (
            <div className="divide-y">
              {/* Header-Row (desktop) — drei visuelle Gruppen via Border-
                  Separators: Mitarbeiter · Stunden · Vergütung. */}
              <div className="hidden md:grid items-center gap-x-2 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                style={{ gridTemplateColumns: "minmax(0, 1.3fr) 65px 65px 65px 65px 85px 95px 105px 95px 60px 60px 60px" }}
              >
                <div>Mitarbeiter</div>
                <div className="text-right border-l border-border pl-2" data-tooltip="Gestempelte Stunden im Monat">Stempel</div>
                <div className="text-right" data-tooltip="Eingeplante Stunden (Termine zugewiesen)">Geplant</div>
                <div className="text-right" data-tooltip="Rapportierte Stunden (= Basis für die Auszahlung)">Rapport</div>
                <div className="text-right border-l border-border pl-2" data-tooltip="Brutto-Stundenlohn">Lohn/h</div>
                <div className="text-right" data-tooltip="Nacht/Sonntag/Feiertag-Zuschläge dieses Monats">Zuschlag</div>
                <div className="text-right" data-tooltip="Brutto = Basis-Lohn + Zuschläge">Brutto</div>
                <div className="text-right text-emerald-700 dark:text-emerald-300 font-semibold" data-tooltip="= Brutto − Mitarbeiter-Abzüge. Das was auf dem Konto landet.">Auszahlung</div>
                <div className="text-right" data-tooltip="Brutto + Arbeitgeber-Anteil (Vollkosten für die Firma)">Vollkosten</div>
                {/* 3 BVG-Forecast-Spalten: aktuell + 2 zukuenftige Monate */}
                <div className="text-center border-l border-border pl-2" data-tooltip={`BVG-Forecast ${bvgMonthLabels[0] || "selektierter Monat"} aus geplanten Terminen — vergleicht gegen ${CHF.format(bvgThreshold)} CHF`}>BVG-Mo</div>
                <div className="text-center" data-tooltip={`BVG-Forecast ${bvgMonthLabels[1] || "+1 Monat"} aus geplanten Terminen`}>+1M</div>
                <div className="text-center" data-tooltip={`BVG-Forecast ${bvgMonthLabels[2] || "+2 Monate"} aus geplanten Terminen`}>+2M</div>
              </div>
              {visibleData.map((r) => (
                <StatsRow key={r.profile_id} row={r} bvgThreshold={bvgThreshold} onClick={() => setDetailFor(r.profile_id)} />
              ))}
              {/* Summen-Zeile */}
              <div className="hidden md:grid items-center gap-x-2 px-4 py-2.5 text-xs font-semibold bg-foreground/[0.03] dark:bg-foreground/[0.06]"
                style={{ gridTemplateColumns: "minmax(0, 1.3fr) 65px 65px 65px 65px 85px 95px 105px 95px 60px 60px 60px" }}
              >
                <div>Summe ({visibleData.length})</div>
                <div className="text-right tabular-nums border-l border-border pl-2">{fmtHours(totals.stempel)}</div>
                <div className="text-right tabular-nums">{fmtHours(totals.geplant)}</div>
                <div className="text-right tabular-nums">{fmtHours(totals.rapport)}</div>
                <div className="text-right tabular-nums border-l border-border pl-2">—</div>
                <div className="text-right tabular-nums">{totals.surcharge > 0 ? `+ ${CHF.format(totals.surcharge)}` : "—"}</div>
                <div className="text-right tabular-nums">CHF {CHF.format(totals.lohnkosten)}</div>
                <div className="text-right tabular-nums text-emerald-700 dark:text-emerald-300">CHF {CHF.format(totals.netto)}</div>
                <div className="text-right tabular-nums">CHF {CHF.format(totals.vollkosten)}</div>
                {/* BVG-Spalten haben keine Summe (pro-MA-Status, nicht aggregierbar). */}
                <div className="text-center border-l border-border pl-2 text-muted-foreground">—</div>
                <div className="text-center text-muted-foreground">—</div>
                <div className="text-center text-muted-foreground">—</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lohnsummen-Prognose — Firmen-Cashflow-Blick fuer die naechsten
          3 Monate. Basiert auf geplanten Terminen + IST-Stempelzeiten
          des laufenden Monats (mit 20% Puffer fuer ungeplante Nachbuchungen).
          Alle Werte inkl. Nacht-/Sonntag-Zuschlaegen nach Schweizer ArG. */}
      {payrollForecast.length > 0 && (
        <Card className="border-blue-500/30 bg-blue-500/[0.02] dark:bg-blue-500/[0.04]">
          <CardContent className="p-0">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                Lohnsummen-Prognose
                <span className="text-[10px] font-normal text-muted-foreground/70 ml-1">
                  aus geplanten Terminen + 20% Puffer, inkl. Zuschlägen
                </span>
              </h3>
            </div>
            <div className="hidden md:grid items-center gap-x-2 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border"
              style={{ gridTemplateColumns: "minmax(0, 1.3fr) 85px 120px 130px 120px" }}
            >
              <div>Monat</div>
              <div className="text-right border-l border-border pl-2" data-tooltip="Geplante + gestempelte Stunden (Puffer 20%)">Stunden</div>
              <div className="text-right" data-tooltip="Brutto-Lohnsumme inkl. Zuschläge">Brutto</div>
              <div className="text-right text-emerald-700 dark:text-emerald-300 font-semibold" data-tooltip="Auszahlung an Mitarbeiter (Brutto − Abzüge)">Auszahlung</div>
              <div className="text-right" data-tooltip="Vollkosten für die Firma (inkl. Arbeitgeber-Anteil)">Vollkosten</div>
            </div>
            {payrollForecast.map((m, i) => {
              // Delta zum Vormonat (nur ab zweiter Zeile)
              const prev = i > 0 ? payrollForecast[i - 1] : null;
              const deltaChf = prev ? m.brutto_chf - prev.brutto_chf : 0;
              const deltaPct = prev && prev.brutto_chf > 0 ? (deltaChf / prev.brutto_chf) * 100 : 0;
              const showDelta = prev != null && Math.abs(deltaChf) > 100;
              return (
                <div
                  key={m.label}
                  className={`hidden md:grid items-center gap-x-2 px-4 py-2.5 text-sm ${m.is_current_month ? "bg-foreground/[0.03] dark:bg-foreground/[0.06] font-medium" : ""}`}
                  style={{ gridTemplateColumns: "minmax(0, 1.3fr) 85px 120px 130px 120px" }}
                >
                  <div className="flex items-center gap-2">
                    <span>{m.label}</span>
                    {m.is_current_month && (
                      <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-700 dark:text-blue-300">laufend</span>
                    )}
                    {showDelta && (
                      <span
                        className={`text-[10px] font-normal tabular-nums ${deltaChf > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}
                        data-tooltip={`${deltaChf > 0 ? "+" : ""}CHF ${CHF.format(deltaChf)} vs. Vormonat`}
                      >
                        {deltaChf > 0 ? "▲" : "▼"} {Math.abs(Math.round(deltaPct))}%
                      </span>
                    )}
                  </div>
                  <div className="text-right tabular-nums border-l border-border pl-2 text-muted-foreground">
                    {fmtHours(m.plan_minutes)}
                  </div>
                  <div className="text-right tabular-nums">CHF {CHF.format(m.brutto_chf)}</div>
                  <div className="text-right tabular-nums font-semibold text-emerald-700 dark:text-emerald-300">
                    CHF {CHF.format(m.netto_chf)}
                  </div>
                  <div className="text-right tabular-nums text-muted-foreground">
                    CHF {CHF.format(m.vollkosten_chf)}
                  </div>
                </div>
              );
            })}
            {/* Mobile-Cards */}
            <div className="md:hidden divide-y">
              {payrollForecast.map((m) => (
                <div key={m.label} className={`px-4 py-3 ${m.is_current_month ? "bg-foreground/[0.03]" : ""}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-sm font-medium">{m.label}</span>
                    {m.is_current_month && (
                      <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-700 dark:text-blue-300">laufend</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Stunden</span>
                    <span className="text-right tabular-nums">{fmtHours(m.plan_minutes)}</span>
                    <span className="text-muted-foreground">Brutto</span>
                    <span className="text-right tabular-nums">CHF {CHF.format(m.brutto_chf)}</span>
                    <span className="text-muted-foreground">Auszahlung</span>
                    <span className="text-right tabular-nums text-emerald-700 dark:text-emerald-300 font-semibold">CHF {CHF.format(m.netto_chf)}</span>
                    <span className="text-muted-foreground">Vollkosten</span>
                    <span className="text-right tabular-nums">CHF {CHF.format(m.vollkosten_chf)}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <EmployeeWageDetailModal
        open={!!detailFor}
        profileId={detailFor}
        initialYear={period.year}
        onClose={() => setDetailFor(null)}
      />

      <Modal open={exportOpen} onClose={() => !exporting && setExportOpen(false)} title="Timesheet Excel-Export" size="md">
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Aktueller Monat ist bereits eingestellt. Für Audits oder Jahres-Reports kannst du den Zeitraum anpassen.
            Pro Mitarbeiter ein eigenes Sheet mit Tag-für-Tag-Aufschlüsselung + Übersichts-Sheet zur Schnellansicht.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Von</p>
              <Input type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Bis</p>
              <Input type="date" value={exportTo} onChange={(e) => setExportTo(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => { setExportFrom(monthStartIso); setExportTo(monthEndIso); }}
              className="kasten kasten-muted text-xs"
              disabled={exporting}
            >
              {fmtMonthLabel(period)}
            </button>
            <button
              type="button"
              onClick={() => { setExportFrom(`${period.year}-01-01`); setExportTo(`${period.year}-12-31`); }}
              className="kasten kasten-muted text-xs"
              disabled={exporting}
            >
              Ganzes Jahr {period.year}
            </button>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setExportOpen(false)} disabled={exporting} className="kasten kasten-muted flex-1">
              Abbrechen
            </button>
            <button
              type="button"
              onClick={() => downloadTimesheet(exportFrom, exportTo)}
              disabled={exporting || !exportFrom || !exportTo || exportFrom > exportTo}
              className="kasten kasten-red flex-1"
            >
              {exporting ? "Generiert…" : "Excel herunterladen"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function StatsRow({ row, bvgThreshold, onClick }: { row: EmployeeStats; bvgThreshold: number; onClick: () => void }) {
  // Tooltip-Aufschluesselung der Zuschlaege fuer Brutto-Tooltip
  const hasSurcharge = row.total_surcharge_chf > 0;
  const bruttoTooltip = hasSurcharge
    ? `Basis ${CHF.format(row.base_lohnkosten_chf ?? 0)}`
      + (row.night_surcharge_chf > 0 ? ` + Nacht (25%, ${(row.night_eligible_minutes / 60).toFixed(1)}h) ${CHF.format(row.night_surcharge_chf)}` : "")
      + (row.sunhol_surcharge_chf > 0 ? ` + So/FT (50%, ${(row.sunhol_eligible_minutes / 60).toFixed(1)}h) ${CHF.format(row.sunhol_surcharge_chf)}` : "")
    : "Basis: Gestempelte Stunden";
  const surchargeTooltip = hasSurcharge
    ? `Nacht: ${CHF.format(row.night_surcharge_chf)} · So/FT: ${CHF.format(row.sunhol_surcharge_chf)}`
    : (row.night_over_limit || row.sunhol_over_limit
        ? "Limit überschritten — Zeitkompensation / Ersatzruhetage statt Geld"
        : "Keine zuschlags-pflichtigen Stunden");

  // Row-Tint wenn IRGENDWAS kritisch ist (>=95% der Schwelle):
  //  - Actual Brutto im selektierten Monat (lohnkosten_chf)
  //  - oder einer der 3 Forecast-Monate
  // Beides pruefen damit "actuals > forecast" (mehr gearbeitet als
  // geplant) trotzdem als BVG-Risiko erkannt wird.
  const actualBrutto = row.lohnkosten_chf ?? 0;
  const actualCritical = actualBrutto >= bvgThreshold * 0.95;
  const forecastCritical = (row.bvg_forecast_3_months_chf ?? [0, 0, 0]).some((chf) => chf >= bvgThreshold * 0.95);
  const anyCritical = actualCritical || forecastCritical;
  const rowTint = anyCritical ? "bg-red-50/40 dark:bg-red-500/[0.06]" : "";

  return (
    <div
      className={`grid items-center gap-x-2 px-4 py-2.5 text-sm transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.06] cursor-pointer ${row.is_active ? "" : "opacity-60"} ${rowTint}`}
      style={{ gridTemplateColumns: "minmax(0, 1.3fr) 65px 65px 65px 65px 85px 95px 105px 95px 60px 60px 60px" }}
      onClick={onClick}
    >
      <div className="min-w-0">
        <div className="font-medium truncate hover:underline flex items-center gap-1.5">
          <span className="truncate">{row.full_name}</span>
          {row.night_shifts_over_limit_this_month > 0 && (
            <span
              className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold border bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-500/20 dark:text-purple-300 dark:border-purple-500/40 shrink-0"
              data-tooltip={`${row.night_shifts_over_limit_this_month} Nacht(e) > Limit diesen Monat — Zeitkomp 10% erworben: ${fmtHours(row.night_time_comp_minutes_this_month)} (YTD-Total: ${fmtHours(row.ytd_night_time_comp_minutes)})`}
            >
              +{fmtHours(row.night_time_comp_minutes_this_month)} Komp
            </span>
          )}
          {!row.is_active && (
            <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-foreground/10 dark:bg-foreground/20 text-muted-foreground font-normal shrink-0">
              deaktiv
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">
          {row.role}
          {row.ytd_night_shifts_total > 0 && (
            <span className="ml-2 text-muted-foreground/60">· {row.ytd_night_shifts_total} Nächte YTD</span>
          )}
        </div>
      </div>
      <div className="text-right tabular-nums border-l border-border pl-2">{fmtHours(row.stempel_minutes)}</div>
      <div className="text-right tabular-nums">{fmtHours(row.geplant_minutes)}</div>
      <div className="text-right tabular-nums">{fmtHours(row.rapport_minutes)}</div>
      <div className="text-right tabular-nums text-muted-foreground border-l border-border pl-2">
        {row.hourly_wage_chf != null ? `CHF ${CHF.format(row.hourly_wage_chf)}` : "—"}
      </div>
      <div className={`text-right tabular-nums ${hasSurcharge ? "text-amber-700 dark:text-amber-300 font-medium" : "text-muted-foreground"}`}
        data-tooltip={surchargeTooltip}
      >
        {hasSurcharge ? `+ ${CHF.format(row.total_surcharge_chf)}` : "—"}
      </div>
      <div
        className={`text-right tabular-nums ${actualCritical ? "text-red-700 dark:text-red-300 font-semibold" : "text-muted-foreground"}`}
        data-tooltip={actualCritical
          ? `${bruttoTooltip} — BVG-Pflicht droht (Brutto ${CHF.format(actualBrutto)} >= 95% von ${CHF.format(bvgThreshold)})`
          : bruttoTooltip}
      >
        {row.lohnkosten_chf != null ? `CHF ${CHF.format(row.lohnkosten_chf)}` : "—"}
      </div>
      <div className="text-right tabular-nums font-bold text-emerald-700 dark:text-emerald-300"
        data-tooltip={`Brutto − Abzüge (${row.total_deduction_pct.toFixed(Math.min(4, Math.max(2, (String(row.total_deduction_pct).split(".")[1] || "").length)))}%) = Auszahlung`}
      >
        {row.nettolohn_chf != null ? `CHF ${CHF.format(row.nettolohn_chf)}` : "—"}
      </div>
      <div className="text-right tabular-nums text-muted-foreground">
        {row.vollkosten_chf != null ? `CHF ${CHF.format(row.vollkosten_chf)}` : "—"}
      </div>
      {/* 3 BVG-Forecast-Spalten */}
      {(row.bvg_forecast_3_months_chf ?? [0, 0, 0]).map((chf, i) => (
        <BvgForecastCell
          key={i}
          chf={chf}
          threshold={bvgThreshold}
          firstCol={i === 0}
        />
      ))}
    </div>
  );
}

/** Mini-Pille pro Monat: zeigt % der BVG-Schwelle. Farbe nach Status. */
function BvgForecastCell({ chf, threshold, firstCol }: { chf: number; threshold: number; firstCol: boolean }) {
  const ratio = threshold > 0 ? chf / threshold : 0;
  const status: "ok" | "warn" | "crit" = ratio >= 0.95 ? "crit" : ratio >= 0.70 ? "warn" : "ok";
  const pct = Math.round(ratio * 100);
  const empty = chf === 0;
  const pillClass =
    empty
      ? "text-muted-foreground/40"
      : status === "crit"
        ? "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
        : status === "warn"
          ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  const tooltip = empty
    ? "Keine geplanten Termine in diesem Monat"
    : `${CHF.format(chf)} / ${CHF.format(threshold)} CHF (${pct}%) — Formel: IST-Brutto + geplante Termine × 1.20 (20% Puffer)${status === "crit" ? " · BVG-Pflicht droht" : ""}`;
  return (
    <div className={`text-center ${firstCol ? "border-l border-border pl-2" : ""}`}>
      <span
        className={`inline-block min-w-[42px] px-1 py-0.5 rounded text-[10px] font-semibold tabular-nums ${pillClass}`}
        data-tooltip={tooltip}
      >
        {empty ? "—" : `${pct}%`}
      </span>
    </div>
  );
}
