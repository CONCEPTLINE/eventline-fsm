"use client";

/**
 * Location-Uebersicht in den Analytics: pro Standort Auftraege +
 * Geplant/Stempel/Rapport-Stunden + Delta-Indikatoren (Kalkulations-
 * Genauigkeit, Stempel↔Rapport-Diskrepanz), Ø Stunden pro Auftrag,
 * letzter Auftrag.
 *
 * Datenquelle: /api/analytics/locations (RPC get_location_stats).
 * Zeitraum-Filter: Alle Zeit / Dieses Jahr / Letzte 12 Monate.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { MapPin, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Row {
  location_id: string;
  location_name: string;
  job_count: number;
  geplant_minutes: number;
  stempel_minutes: number;
  rapport_minutes: number;
  last_job_date: string | null;
}

type RangeKey = "all" | "ytd" | "12m";

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: "all", label: "Alle Zeit" },
  { key: "ytd", label: "Dieses Jahr" },
  { key: "12m", label: "Letzte 12 Monate" },
];

function rangeToParams(key: RangeKey): { from?: string; to?: string } {
  const now = new Date();
  const y = now.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", year: "numeric" });
  if (key === "ytd") return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (key === "12m") {
    const from = new Date(now); from.setMonth(now.getMonth() - 12);
    return { from: from.toISOString().slice(0, 10) };
  }
  return {};
}

function formatHours(min: number): string {
  const h = min / 60;
  if (h >= 100) return `${Math.round(h)}h`;
  if (h >= 10) return `${h.toFixed(1)}h`;
  return `${h.toFixed(1)}h`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "2-digit",
  });
}

/** +/-% zwischen Ist (b) und Soll (a). null wenn a=0. */
function pctDelta(a: number, b: number): number | null {
  if (a <= 0) return null;
  return ((b - a) / a) * 100;
}

/** Absolutes Delta in Minuten. */
function absDeltaMin(a: number, b: number): number { return Math.abs(b - a); }

export function LocationOverview() {
  const [rows, setRows] = useState<Row[]>([]);
  const [range, setRange] = useState<RangeKey>(() => {
    if (typeof window === "undefined") return "all";
    return (localStorage.getItem("analytics-loc-range") as RangeKey) || "all";
  });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = rangeToParams(range);
      const qs = new URLSearchParams();
      if (p.from) qs.set("from", p.from);
      if (p.to) qs.set("to", p.to);
      const res = await fetch(`/api/analytics/locations${qs.toString() ? "?" + qs.toString() : ""}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error || "Konnte Location-Statistik nicht laden");
        return;
      }
      setRows(json.rows as Row[]);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("analytics-loc-range", range);
  }, [range]);

  // Firmen-Total fuer die Fuss-Zeile.
  const totals = useMemo(() => {
    return rows.reduce((acc, r) => ({
      jobs: acc.jobs + r.job_count,
      geplant: acc.geplant + r.geplant_minutes,
      stempel: acc.stempel + r.stempel_minutes,
      rapport: acc.rapport + r.rapport_minutes,
    }), { jobs: 0, geplant: 0, stempel: 0, rapport: 0 });
  }, [rows]);

  return (
    <Card className="bg-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <MapPin className="h-4 w-4" /> Locations — Auslastungsuebersicht
            </h2>
            <p className="text-xs text-muted-foreground">
              Auftraege, Stunden und Kalkulations-Genauigkeit pro Standort. Sortiert nach gestempelten Stunden.
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setRange(opt.key)}
                className={`kasten ${range === opt.key ? "kasten-active" : "kasten-toggle-off"}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Lade...
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground italic">
            Keine Auftraege im gewaehlten Zeitraum.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="text-left py-2 pr-3 font-medium">Location</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Anzahl abgeschlossener/laufender Auftraege im Zeitraum (ohne Storno/Entwurf)">Auftraege</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Summe aller geplanten Termine">Geplant</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Summe aller abgeschlossenen Stempelungen">Stempel</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Summe der Rapport-Zeilen aus abgeschlossenen Einsatzrapporten">Rapport</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Abweichung Stempel zu Geplant. Positiv = laenger gedauert als kalkuliert.">Δ Kalk.</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Diskrepanz Stempel zu Rapport. Rot wenn > 15% Abweichung — Kunde sieht andere Zahl als intern erfasst.">Δ Rap.</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Ø Stempel-Stunden pro Auftrag — typische Einsatz-Groesse">Ø/Auftr.</th>
                  <th className="text-right py-2 pl-2 pr-1 font-medium" data-tooltip="Datum des letzten Auftrags an dieser Location">Zuletzt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const deltaKalk = pctDelta(r.geplant_minutes, r.stempel_minutes);
                  const deltaRap = pctDelta(r.stempel_minutes, r.rapport_minutes);
                  const avgPerJob = r.job_count > 0 ? r.stempel_minutes / r.job_count : 0;
                  // Rapport-Diskrepanz > 15% ist erklaerungsbeduerftig.
                  const rapCritical = deltaRap !== null && Math.abs(deltaRap) > 15;
                  return (
                    <tr key={r.location_id} className="hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]">
                      <td className="py-2 pr-3 font-medium truncate max-w-[200px]" title={r.location_name}>{r.location_name}</td>
                      <td className="text-right py-2 px-2 tabular-nums">{r.job_count}</td>
                      <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">{formatHours(r.geplant_minutes)}</td>
                      <td className="text-right py-2 px-2 tabular-nums font-semibold">{formatHours(r.stempel_minutes)}</td>
                      <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">{formatHours(r.rapport_minutes)}</td>
                      <td className={`text-right py-2 px-2 tabular-nums ${deltaKalk === null ? "text-muted-foreground/40" : Math.abs(deltaKalk) > 20 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                        {deltaKalk === null ? "—" : `${deltaKalk >= 0 ? "+" : ""}${deltaKalk.toFixed(0)}%`}
                      </td>
                      <td className={`text-right py-2 px-2 tabular-nums ${deltaRap === null ? "text-muted-foreground/40" : rapCritical ? "text-red-600 dark:text-red-400 font-semibold" : "text-muted-foreground"}`}>
                        {deltaRap === null ? "—" : `${deltaRap >= 0 ? "+" : ""}${deltaRap.toFixed(0)}%`}
                      </td>
                      <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">{formatHours(avgPerJob)}</td>
                      <td className="text-right py-2 pl-2 pr-1 tabular-nums text-muted-foreground">{formatDate(r.last_job_date)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold text-[11px]">
                  <td className="py-2 pr-3">Total ({rows.length} Locations)</td>
                  <td className="text-right py-2 px-2 tabular-nums">{totals.jobs}</td>
                  <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">{formatHours(totals.geplant)}</td>
                  <td className="text-right py-2 px-2 tabular-nums">{formatHours(totals.stempel)}</td>
                  <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">{formatHours(totals.rapport)}</td>
                  <td colSpan={3}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
