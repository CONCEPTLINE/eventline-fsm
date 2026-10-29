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
 * Default = aktueller Monat; der gewählte Monat steht in der URL (?monat=YYYY-MM,
 * überlebt Reload; Alarm-Mail und Glocke verlinken direkt dorthin).
 *
 * Spalte «Status» (Lohn-Umbau Phase 4, /api/hr/monatsstatus): fehlt / erstellt /
 * blockiert / Korrektur / Fehler / ausbezahlt, «—» solange der Monat offen ist
 * (bei Stempel-Problemen mit dezentem Hinweis). Klick öffnet den Abschluss-
 * Dialog (MonatsabschlussDialog): Stempel prüfen bzw. Ende per Antrag setzen,
 * Abrechnung erstellen, «ausbezahlt» markieren oder stornieren.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Wallet, Shield, Download, AlertTriangle, Info, CheckCircle2, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { toast } from "sonner";
import { Loading } from "@/components/ui/spinner";
import { EmployeeWageDetailModal } from "@/components/hr/employee-wage-detail-modal";
import { logError } from "@/lib/log";
import { formatDate, toLocalIsoString } from "@/lib/format";
import { localDateIso, localTimeHM, todayLocalIso } from "@/lib/swiss-time";
import { istMonatGesperrt } from "@/lib/lohn/monate";

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
  /** Angewandte Mitarbeiter-Abzuege in % (NBU nur, wenn NBU-versichert). */
  total_deduction_pct: number;
  /** NBU-Status des Monats als Satz, z. B. «NBU: nicht versichert — Ø 3.2 h …»; null = kein NBU-Satz hinterlegt. */
  nbu_hinweis: string | null;
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
  /** Rechenkern-Fehler (fehlende Daten) — Beträge sind dann null, nie Ersatzwerte. */
  fehler: string | null;
  /** Hinweise des Rechenkerns zum Monat (z. B. Sätze aus späterer Lohnzeile). */
  hinweise: string[];
}

/** Statusspalte (GET /api/hr/monatsstatus, Phase 4). */
type MonatsStatus = "offen" | "keine" | "fehlt" | "erstellt" | "blockiert" | "korrektur" | "fehler" | "ausbezahlt";
interface StempelProblem {
  id: string;
  art: "offen" | "lang";
  clockIn: string;
  clockOut: string | null;
  dauerMinuten: number;
  langBegruendung: string | null;
}
interface StatusZeile {
  profile_id: string;
  status: MonatsStatus;
  text: string;
  fassung: { momentaufnahme_id: string; fassung: number; art: "regulaer" | "korrektur" | "altbestand"; auszahlungsdatum: string; geschaetzt: boolean; betrag: number; wage_document_id: string | null } | null;
  auszahlung: { id: string | null; ausbezahlt_am: string; betrag: number; erfasst_von_name: string | null; erfasst_at: string | null; uebernommen: boolean } | null;
  korrektur_vorschlag: boolean;
  stempel: StempelProblem[];
  fehler: string | null;
}

const STATUS_LABEL: Record<MonatsStatus, string> = {
  offen: "—", keine: "—", fehlt: "fehlt", erstellt: "erstellt", blockiert: "blockiert", korrektur: "Korrektur", fehler: "Fehler", ausbezahlt: "ausbezahlt",
};
const STATUS_KLASSE: Record<MonatsStatus, string> = {
  offen: "", keine: "",
  fehlt: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/40",
  erstellt: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/40",
  blockiert: "bg-red-100 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/40",
  korrektur: "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-500/20 dark:text-purple-300 dark:border-purple-500/40",
  fehler: "bg-red-600 text-white border-red-700 dark:bg-red-500/70 dark:text-white dark:border-red-400",
  ausbezahlt: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/40",
};

const GRID = "minmax(0, 1.3fr) 65px 65px 65px 65px 85px 95px 105px 95px 60px 60px 60px 92px";

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

/** Ganze Lohnmonate, die der Export-Zeitraum berührt: «Oktober 2026 – Dezember 2026». */
function lohnmonateLabel(from: string, to: string): string | null {
  const iso = /^(\d{4})-(\d{2})-\d{2}$/;
  const a = iso.exec(from);
  const b = iso.exec(to);
  if (!a || !b || from > to) return null;
  const von = { year: Number(a[1]), month: Number(a[2]) };
  const bis = { year: Number(b[1]), month: Number(b[2]) };
  return von.year === bis.year && von.month === bis.month
    ? fmtMonthLabel(von)
    : `${fmtMonthLabel(von)} – ${fmtMonthLabel(bis)}`;
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

/** ?monat=YYYY-MM aus der URL (Alarm-Mail, Glocke, Reload), sonst aktueller Monat. */
function monatAusUrl(wert: string | null): { year: number; month: number } {
  const t = wert ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(wert) : null;
  return t ? { year: Number(t[1]), month: Number(t[2]) } : todayMonth();
}

export function MonatsstundenTable() {
  const searchParams = useSearchParams();
  const [period, setPeriodState] = useState<{ year: number; month: number }>(() => monatAusUrl(searchParams.get("monat")));
  // Statusspalte (eigener Abruf, lädt parallel zu den Stunden). null = lädt.
  const [status, setStatus] = useState<Map<string, StatusZeile> | null>(null);
  const [statusVersion, setStatusVersion] = useState(0);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  // Monat wechseln: in die URL schreiben (überlebt Reload, andere Parameter bleiben).
  const setPeriod = (update: (p: { year: number; month: number }) => { year: number; month: number }) => {
    const neu = update(period);
    setPeriodState(neu);
    setStatus(null);
    const url = new URL(window.location.href);
    url.searchParams.set("monat", fmtMonth(neu));
    window.history.replaceState(window.history.state, "", url.toString());
  };
  const statusNeuLaden = useCallback(() => setStatusVersion((v) => v + 1), []);
  const [data, setData] = useState<EmployeeStats[]>([]);
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
      })
      .catch((err) => {
        if (cancelled) return;
        logError("monatsstunden-table.load", err, { period: fmtMonth(period) });
        toast.error("Netzwerkfehler beim Laden der Monatsstunden");
        setData([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  // Statusspalte: bei Monatswechsel und nach jeder Aktion im Abschluss-Dialog.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/hr/monatsstatus?month=${fmtMonth(period)}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})))
      .then((json) => {
        if (cancelled) return;
        if (!json.success) {
          toast.error(`Status: ${json.error || json.message || "konnte nicht geladen werden"}`);
          setStatus(new Map());
          return;
        }
        setStatus(new Map((json.zeilen as StatusZeile[]).map((z) => [z.profile_id, z])));
      })
      .catch((err) => {
        if (cancelled) return;
        logError("monatsstunden-table.status", err, { period: fmtMonth(period) });
        toast.error("Netzwerkfehler beim Laden der Statusspalte");
        setStatus(new Map());
      });
    return () => { cancelled = true; };
  }, [period, statusVersion]);

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
            <Wallet className="h-4 w-4" /> Monatsstunden
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
                style={{ gridTemplateColumns: GRID }}
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
                <div className="text-center border-l border-border pl-2" data-tooltip="Monatsabschluss: fehlt / erstellt / blockiert (Stempel prüfen) / Korrektur / Fehler / ausbezahlt — «—» solange der Monat offen ist. Klick für Details.">Status</div>
              </div>
              {visibleData.map((r) => (
                <StatsRow
                  key={r.profile_id}
                  row={r}
                  bvgThreshold={bvgThreshold}
                  onClick={() => setDetailFor(r.profile_id)}
                  status={status ? status.get(r.profile_id) ?? null : undefined}
                  onStatus={() => setStatusFor(r.profile_id)}
                />
              ))}
              {/* Summen-Zeile */}
              <div className="hidden md:grid items-center gap-x-2 px-4 py-2.5 text-xs font-semibold bg-foreground/[0.03] dark:bg-foreground/[0.06]"
                style={{ gridTemplateColumns: GRID }}
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
                <div className="text-center border-l border-border pl-2 text-muted-foreground">—</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>


      <MonatsabschlussDialog
        zeile={statusFor ? status?.get(statusFor) ?? null : null}
        name={data.find((r) => r.profile_id === statusFor)?.full_name ?? ""}
        period={period}
        onClose={() => setStatusFor(null)}
        onGeaendert={statusNeuLaden}
      />

      <EmployeeWageDetailModal
        open={!!detailFor}
        profileId={detailFor}
        initialYear={period.year}
        initialMonth={period.month}
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
          {/* Der Export rechnet immer ganze Lohnmonate (alle Monate, die der Zeitraum berührt). */}
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
            <span>
              Exportiert werden immer ganze Lohnmonate
              {lohnmonateLabel(exportFrom, exportTo) ? <>: <strong className="font-medium text-foreground">{lohnmonateLabel(exportFrom, exportTo)}</strong></> : ""}.
            </span>
          </p>
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

function StatsRow({ row, bvgThreshold, onClick, status, onStatus }: {
  row: EmployeeStats;
  bvgThreshold: number;
  onClick: () => void;
  /** undefined = lädt, null = keine Zeile (z. B. Portal). */
  status: StatusZeile | null | undefined;
  onStatus: () => void;
}) {
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
      className={`row-hover [--row-hover-x:0.5rem] grid items-center gap-x-2 px-4 py-2.5 text-sm cursor-pointer ${row.is_active ? "" : "opacity-60"} ${rowTint}`}
      style={{ gridTemplateColumns: GRID }}
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
          {row.fehler && (
            <span
              className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold border bg-red-100 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/40 shrink-0"
              data-tooltip={row.fehler}
            >
              <AlertTriangle className="h-2.5 w-2.5" />Fehler
            </span>
          )}
          {row.hinweise?.length > 0 && (
            <span className="inline-flex shrink-0 text-muted-foreground" data-tooltip={row.hinweise.join("\n")} aria-label="Hinweise">
              <Info className="h-3 w-3" />
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
        data-tooltip={`Brutto − Abzüge (${row.total_deduction_pct.toFixed(Math.min(4, Math.max(2, (String(row.total_deduction_pct).split(".")[1] || "").length)))}%) = Auszahlung${row.nbu_hinweis ? ` · ${row.nbu_hinweis}` : ""}`}
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
      <StatusZelle zeile={status} onClick={onStatus} />
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

/** Zelle «Status»: Pille (klickbar) bzw. «—» für offene Monate, bei
 *  Stempel-Problemen mit dezentem Hinweis. */
function StatusZelle({ zeile, onClick }: { zeile: StatusZeile | null | undefined; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  if (zeile === undefined) {
    return <div className="border-l border-border pl-2 flex justify-center"><div className="shimmer rounded h-4 w-14" /></div>;
  }
  if (zeile === null) return <div className="border-l border-border pl-2 text-center text-muted-foreground">—</div>;
  const klick = (e: React.MouseEvent) => { e.stopPropagation(); onClick(); };
  if (zeile.status === "offen" || zeile.status === "keine") {
    return (
      <div className="border-l border-border pl-2 flex items-center justify-center gap-1 text-muted-foreground">
        <span data-tooltip={zeile.text}>—</span>
        {zeile.stempel.length > 0 && (
          <button
            type="button"
            onClick={klick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            className="inline-flex items-center rounded p-0.5 text-amber-600 dark:text-amber-400"
            style={{ backgroundColor: hover ? "rgba(245, 158, 11, 0.18)" : undefined }}
            data-tooltip={`${zeile.stempel.length === 1 ? "1 Stempel" : `${zeile.stempel.length} Stempel`} prüfen (offen oder über 16 h) — vor der Sperre erledigen`}
            aria-label="Stempel prüfen"
          >
            <AlertTriangle className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="border-l border-border pl-2 text-center">
      <button
        type="button"
        onClick={klick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${STATUS_KLASSE[zeile.status]}`}
        style={{ boxShadow: hover ? "0 0 0 1px currentColor" : undefined }}
        data-tooltip={zeile.text}
      >
        {zeile.status === "fehler" || zeile.status === "blockiert" ? <AlertTriangle className="h-2.5 w-2.5" /> : null}
        {zeile.status === "ausbezahlt" ? <CheckCircle2 className="h-2.5 w-2.5" /> : null}
        {STATUS_LABEL[zeile.status]}
      </button>
    </div>
  );
}

const STEMPEL_TAG = (iso: string) => formatDate(iso);
const STEMPEL_ZEIT = (iso: string) => localTimeHM(new Date(iso));
const DAUER = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} h`;
const CHF_TEXT = (n: number) => `CHF ${CHF.format(n)}`;
const DATUM = (iso: string) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
const BEGRUENDUNG_MIN = 10;

/** Abschluss-Dialog einer Person/eines Monats: Stempel prüfen, Abrechnung
 *  erstellen, «ausbezahlt» markieren bzw. stornieren. Jede Aktion lädt danach
 *  die Statusspalte neu (Daten nur aus der DB). */
function MonatsabschlussDialog({ zeile, name, period, onClose, onGeaendert }: {
  zeile: StatusZeile | null;
  name: string;
  period: { year: number; month: number };
  onClose: () => void;
  onGeaendert: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [datum, setDatum] = useState("");
  const [storno, setStorno] = useState("");
  const [stornoOffen, setStornoOffen] = useState(false);
  const [endeFuer, setEndeFuer] = useState<string | null>(null);
  const [endeDatum, setEndeDatum] = useState("");
  const [endeZeit, setEndeZeit] = useState("");
  const [begruendung, setBegruendung] = useState("");
  const [langBegruendung, setLangBegruendung] = useState("");
  const [meldung, setMeldung] = useState<string | null>(null);

  // Neue Person / neue Fassung → Eingaben zurücksetzen (Zustand an die Daten anpassen, kein Effekt).
  const schluessel = zeile ? `${zeile.profile_id}|${zeile.fassung?.momentaufnahme_id ?? ""}|${zeile.auszahlung?.id ?? ""}` : null;
  const [fuer, setFuer] = useState<string | null>(null);
  if (schluessel !== fuer) {
    setFuer(schluessel);
    const heute = todayLocalIso();
    setDatum(zeile?.fassung ? (zeile.fassung.auszahlungsdatum < heute ? zeile.fassung.auszahlungsdatum : heute) : heute);
    setStorno("");
    setStornoOffen(false);
    setEndeFuer(null);
    setMeldung(null);
  }

  const monatText = fmtMonthLabel(period);
  const gesperrt = istMonatGesperrt({ jahr: period.year, monat: period.month }, todayLocalIso());

  async function senden(key: string, url: string, method: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(key);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ...j, _status: res.status };
    } catch (e) {
      toast.error(`Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }
  const fehlerText = (j: Record<string, unknown>, sonst: string) => String(j.error === "device_not_trusted" ? j.message : j.error ?? j.meldung ?? j.message ?? sonst);

  async function pruefen(p: StempelProblem) {
    const j = await senden(`pruefen-${p.id}`, "/api/hr/stempel-pruefen", "POST", { id: p.id });
    if (!j) return;
    if (!j.success) { toast.error(fehlerText(j, "Prüfen fehlgeschlagen")); return; }
    toast.success("Stempel als korrekt bestätigt");
    onGeaendert();
  }

  function endeOeffnen(p: StempelProblem) {
    setEndeFuer(p.id);
    setEndeDatum(p.clockOut ? localDateIso(new Date(p.clockOut)) : localDateIso(new Date(p.clockIn)));
    setEndeZeit(p.clockOut ? localTimeHM(new Date(p.clockOut)) : "");
    setBegruendung("");
    setLangBegruendung(p.langBegruendung ?? "");
    setMeldung(null);
  }

  async function endeSetzen(p: StempelProblem) {
    if (!endeDatum || !endeZeit) { toast.error("Datum und Uhrzeit des Endes eingeben"); return; }
    const clockOut = toLocalIsoString(endeDatum, endeZeit);
    const dauerMs = new Date(clockOut).getTime() - new Date(p.clockIn).getTime();
    if (!(dauerMs > 0)) { toast.error("Das Ende muss nach dem Beginn liegen"); return; }
    if (gesperrt && begruendung.trim().length < BEGRUENDUNG_MIN) { toast.error(`Begründung: mindestens ${BEGRUENDUNG_MIN} Zeichen`); return; }
    if (dauerMs > 16 * 3600_000 && !langBegruendung.trim()) { toast.error("Über 16 Stunden: Begründung der Dauer nötig"); return; }
    const j = await senden(`ende-${p.id}`, "/api/hr/stempel-antrag", "POST", {
      op: "update",
      id: p.id,
      clock_out: clockOut,
      lang_begruendung: langBegruendung.trim() || null,
      begruendung: begruendung.trim() || null,
    });
    if (!j) return;
    if (j.mode === "begruendung_noetig") { setMeldung(String(j.meldung ?? "Begründung nötig")); return; }
    if (!j.success) { toast.error(fehlerText(j, "Ende konnte nicht gesetzt werden")); return; }
    toast.success(j.mode === "antrag" ? String(j.meldung ?? "Antrag gestellt — die zweite Person bestätigt ihn unter Anträge") : "Ende gesetzt");
    setEndeFuer(null);
    onGeaendert();
  }

  async function erstellen() {
    if (!zeile) return;
    const j = await senden("erstellen", "/api/hr/wage-documents/generate", "POST", { profile_id: zeile.profile_id, year: period.year, month: period.month, neue_fassung: false });
    if (!j) return;
    if (!j.success) {
      toast.error(j.requires_confirm === "neue_fassung" ? "Für diesen Monat gibt es schon eine Fassung — eine Korrektur geht unter Lohndokumente." : fehlerText(j, "Erstellen fehlgeschlagen"));
      onGeaendert();
      return;
    }
    toast.success("Lohnabrechnung erstellt");
    onGeaendert();
  }

  async function ausbezahlt() {
    if (!zeile?.fassung) return;
    const j = await senden("ausbezahlt", "/api/hr/auszahlungen", "POST", { momentaufnahme_id: zeile.fassung.momentaufnahme_id, ausbezahlt_am: datum });
    if (!j) return;
    if (!j.success) { toast.error(fehlerText(j, "Konnte nicht markiert werden")); return; }
    toast.success("Als ausbezahlt markiert");
    onGeaendert();
  }

  async function stornieren() {
    if (!zeile?.auszahlung?.id) return;
    const j = await senden("storno", "/api/hr/auszahlungen", "PATCH", { id: zeile.auszahlung.id, storno_grund: storno.trim() });
    if (!j) return;
    if (!j.success) { toast.error(fehlerText(j, "Storno fehlgeschlagen")); return; }
    toast.success("Auszahlung storniert");
    onGeaendert();
  }

  const z = zeile;
  const kannErstellen = !!z && gesperrt && !z.fassung && (z.status === "fehlt" || z.status === "fehler" || z.status === "blockiert");
  const kannMarkieren = !!z?.fassung && z.fassung.art !== "altbestand" && !z.auszahlung;

  return (
    <Modal open={!!z} onClose={() => { if (!busy) onClose(); }} closable={!busy} title={`${name} · ${monatText}`} size="md">
      {z && (
        <div className="space-y-4 text-sm">
          <div className="flex items-start gap-2">
            {z.status === "offen" || z.status === "keine"
              ? <span className="text-xs text-muted-foreground">Monat {z.status === "offen" ? "noch offen" : "ohne Abrechnung"}</span>
              : <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold shrink-0 ${STATUS_KLASSE[z.status]}`}>{STATUS_LABEL[z.status]}</span>}
            <span className="text-xs text-muted-foreground">{z.text}</span>
          </div>

          {z.stempel.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Stempel prüfen</p>
              <ul className="space-y-1.5">
                {z.stempel.map((p) => (
                  <li key={p.id} className="rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.08] px-2 py-1.5 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span className="font-medium tabular-nums">
                        {STEMPEL_TAG(p.clockIn)} {STEMPEL_ZEIT(p.clockIn)} – {p.clockOut ? `${STEMPEL_TAG(p.clockOut) === STEMPEL_TAG(p.clockIn) ? "" : `${STEMPEL_TAG(p.clockOut)} `}${STEMPEL_ZEIT(p.clockOut)}` : "offen"}
                      </span>
                      <span className="text-muted-foreground tabular-nums">{p.art === "offen" ? `läuft seit ${DAUER(p.dauerMinuten)}` : `${DAUER(p.dauerMinuten)} · über 16 h, ungeprüft`}</span>
                    </div>
                    {p.langBegruendung && <p className="text-[11px] text-muted-foreground">Begründung: {p.langBegruendung}</p>}
                    {endeFuer === p.id ? (
                      <div className="space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Input type="date" value={endeDatum} onChange={(e) => setEndeDatum(e.target.value)} className="h-8 w-[150px] text-xs" disabled={!!busy} />
                          <ZeitFeld value={endeZeit} onChange={setEndeZeit} className="h-8 w-[80px] text-xs" disabled={!!busy} />
                          <span className="text-[11px] text-muted-foreground">Ende</span>
                        </div>
                        <Input value={begruendung} onChange={(e) => setBegruendung(e.target.value)} placeholder={gesperrt ? "Begründung des Antrags (Pflicht, z. B. «laut Einsatzplan bis 23:00»)" : "Begründung (optional)"} maxLength={500} className="h-8 text-xs" disabled={!!busy} />
                        {endeDatum && endeZeit && new Date(toLocalIsoString(endeDatum, endeZeit)).getTime() - new Date(p.clockIn).getTime() > 16 * 3600_000 && (
                          <Input value={langBegruendung} onChange={(e) => setLangBegruendung(e.target.value)} placeholder="Warum über 16 Stunden? (Pflicht)" maxLength={500} className="h-8 text-xs" disabled={!!busy} />
                        )}
                        {meldung && <p className="text-[11px] text-amber-700 dark:text-amber-300">{meldung}</p>}
                        <div className="flex gap-1.5">
                          <button type="button" onClick={() => setEndeFuer(null)} disabled={!!busy} className="kasten kasten-muted text-xs">Abbrechen</button>
                          <button type="button" onClick={() => void endeSetzen(p)} disabled={!!busy} className="kasten kasten-blue text-xs">
                            {busy === `ende-${p.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {gesperrt ? "Antrag stellen" : "Ende speichern"}
                          </button>
                        </div>
                        {gesperrt && <p className="text-[10px] text-muted-foreground">Der Monat ist abgerechnet — die Änderung bestätigt eine zweite Person unter Anträge (Vier Augen).</p>}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {p.art === "lang" && (
                          <button type="button" onClick={() => void pruefen(p)} disabled={!!busy} className="kasten kasten-green text-xs" data-tooltip="Die lange Dauer stimmt — der Stempel blockiert die Abrechnung nicht mehr">
                            {busy === `pruefen-${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Stempel ist korrekt
                          </button>
                        )}
                        <button type="button" onClick={() => endeOeffnen(p)} disabled={!!busy} className="kasten kasten-muted text-xs">
                          {gesperrt ? "Ende per Antrag setzen" : "Ende setzen"}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {z.fehler && z.status === "fehler" && (
            <p className="text-xs rounded-md border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/[0.08] px-2 py-1.5">{z.fehler}</p>
          )}

          {z.fassung && (
            <div className="text-xs space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Abrechnung</p>
              <p>
                Fassung {z.fassung.fassung} ({z.fassung.art === "korrektur" ? "Korrektur" : z.fassung.art === "altbestand" ? "Altbestand" : "regulär"}) ·
                Auszahlung {DATUM(z.fassung.auszahlungsdatum)}{z.fassung.geschaetzt ? " (geschätzt)" : ""} ·{" "}
                <span className="font-medium tabular-nums">{CHF_TEXT(z.fassung.betrag)}</span>
                {z.fassung.art === "korrektur" && <span className="text-muted-foreground"> (Differenz zur Vorfassung)</span>}
              </p>
              {z.korrektur_vorschlag && <p className="text-purple-700 dark:text-purple-300">Korrektur-Vorschlag offen — unter Lohndokumente › Korrektur-Vorschläge erstellen.</p>}
            </div>
          )}

          {z.auszahlung && (
            <div className="text-xs space-y-1.5">
              <p className="text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                {z.auszahlung.uebernommen
                  ? `Übernommen (Altbestand) — ausbezahlt am ${DATUM(z.auszahlung.ausbezahlt_am)}`
                  : `Ausbezahlt am ${DATUM(z.auszahlung.ausbezahlt_am)} · ${CHF_TEXT(z.auszahlung.betrag)}${z.auszahlung.erfasst_von_name ? ` · erfasst von ${z.auszahlung.erfasst_von_name}` : ""}`}
              </p>
              {!z.auszahlung.uebernommen && (stornoOffen ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input value={storno} onChange={(e) => setStorno(e.target.value)} placeholder="Grund des Stornos (Pflicht)" maxLength={500} className="h-8 text-xs flex-1 min-w-[200px]" disabled={!!busy} />
                  <button type="button" onClick={() => setStornoOffen(false)} disabled={!!busy} className="kasten kasten-muted text-xs">Abbrechen</button>
                  <button type="button" onClick={() => void stornieren()} disabled={!!busy || storno.trim().length < 5} className="kasten kasten-red text-xs disabled:opacity-50">
                    {busy === "storno" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Stornieren
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setStornoOffen(true)} disabled={!!busy} className="kasten kasten-red text-xs">Storno</button>
              ))}
            </div>
          )}

          {kannMarkieren && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Input type="date" value={datum} max={todayLocalIso()} onChange={(e) => setDatum(e.target.value)} className="h-8 w-[150px] text-xs" disabled={!!busy} />
              <button type="button" onClick={() => void ausbezahlt()} disabled={!!busy || !datum} className="kasten kasten-green text-xs">
                {busy === "ausbezahlt" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Als ausbezahlt markieren
              </button>
            </div>
          )}

          {kannErstellen && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => void erstellen()}
                disabled={!!busy || z.stempel.length > 0}
                className="kasten kasten-red text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                data-tooltip={z.stempel.length > 0 ? "Zuerst die Stempel oben prüfen bzw. das Ende setzen" : undefined}
              >
                {busy === "erstellen" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {busy === "erstellen" ? "Erstellt…" : "Abrechnung jetzt erstellen"}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
