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
import { ChevronLeft, ChevronRight, Wallet, Shield } from "lucide-react";
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
  effective_basis: "rapport" | "stempel";
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
  const [bvgThreshold, setBvgThreshold] = useState<number>(1890);
  const [loading, setLoading] = useState(true);
  const [detailFor, setDetailFor] = useState<string | null>(null);
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
                style={{ gridTemplateColumns: "minmax(0, 1.3fr) 65px 65px 65px 65px 85px 95px 105px 95px" }}
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
              </div>
              {visibleData.map((r) => (
                <StatsRow key={r.profile_id} row={r} bvgThreshold={bvgThreshold} onClick={() => setDetailFor(r.profile_id)} />
              ))}
              {/* Summen-Zeile */}
              <div className="hidden md:grid items-center gap-x-2 px-4 py-2.5 text-xs font-semibold bg-foreground/[0.03] dark:bg-foreground/[0.06]"
                style={{ gridTemplateColumns: "minmax(0, 1.3fr) 65px 65px 65px 65px 85px 95px 105px 95px" }}
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
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <EmployeeWageDetailModal
        open={!!detailFor}
        profileId={detailFor}
        initialYear={period.year}
        onClose={() => setDetailFor(null)}
      />
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
    : (row.effective_basis === "rapport" ? "Basis: Rapport-Stunden" : "Basis: Stempel-Stunden (kein Rapport)");
  const surchargeTooltip = hasSurcharge
    ? `Nacht: ${CHF.format(row.night_surcharge_chf)} · So/FT: ${CHF.format(row.sunhol_surcharge_chf)}`
    : (row.night_over_limit || row.sunhol_over_limit
        ? "Limit überschritten — Zeitkompensation / Ersatzruhetage statt Geld"
        : "Keine zuschlags-pflichtigen Stunden");

  // BVG-Status: vergleicht Brutto (lohnkosten_chf inkl. Zuschlaege) gegen
  // die Eintrittsschwelle. Pille erscheint nur ab >=70% damit die Tabelle
  // bei niedrigen Pensen sauber bleibt. Crit-Faerbung (>=95%) tinted die
  // ganze Zeile damit Admin beim Scannen sofort sieht wo's brennt.
  const brutto = row.lohnkosten_chf ?? 0;
  const bvgRatio = bvgThreshold > 0 ? brutto / bvgThreshold : 0;
  const bvgStatus: "ok" | "warn" | "crit" = bvgRatio >= 0.95 ? "crit" : bvgRatio >= 0.70 ? "warn" : "ok";
  const bvgPct = Math.round(bvgRatio * 100);
  const showBvg = bvgStatus !== "ok" && brutto > 0;
  const bvgPillClass =
    bvgStatus === "crit"
      ? "bg-red-100 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/40"
      : "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/40";
  const bvgTooltip = `BVG-Schwelle ${CHF.format(bvgThreshold)} CHF/Monat — Brutto ${CHF.format(brutto)} (${bvgPct}%)${bvgStatus === "crit" ? " — BVG-Pflicht droht" : ""}`;
  const rowTint = bvgStatus === "crit" ? "bg-red-50/40 dark:bg-red-500/[0.06]" : "";

  return (
    <div
      className={`grid items-center gap-x-2 px-4 py-2.5 text-sm transition-colors hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.06] cursor-pointer ${row.is_active ? "" : "opacity-60"} ${rowTint}`}
      style={{ gridTemplateColumns: "minmax(0, 1.3fr) 65px 65px 65px 65px 85px 95px 105px 95px" }}
      onClick={onClick}
    >
      <div className="min-w-0">
        <div className="font-medium truncate hover:underline flex items-center gap-1.5">
          {row.full_name}
          {showBvg && (
            <span
              className={`inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold border ${bvgPillClass}`}
              data-tooltip={bvgTooltip}
            >
              <Shield className="h-2.5 w-2.5" />
              BVG {bvgPct}%
            </span>
          )}
          {!row.is_active && (
            <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-foreground/10 dark:bg-foreground/20 text-muted-foreground font-normal">
              deaktiv
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">{row.role}</div>
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
      <div className="text-right tabular-nums text-muted-foreground"
        data-tooltip={bruttoTooltip}
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
    </div>
  );
}
