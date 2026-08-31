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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { MapPin, Loader2, Printer, Download } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";

interface Row {
  location_id: string;
  location_name: string;
  job_count: number;
  geplant_minutes: number;
  stempel_minutes: number;
  rapport_minutes: number;
  last_job_date: string | null;
  hourly_rate_chf: number | null;
  vollkosten_chf: number;
}

const CHF = new Intl.NumberFormat("de-CH", { style: "decimal", maximumFractionDigits: 0 });

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

/** Inline-editierbarer Stundensatz. Speichert bei blur oder Enter,
 *  wenn sich der Wert geaendert hat. Leerer Wert = null (Umsatz aus). */
function RateInput({ initial, onSave }: { initial: number | null; onSave: (raw: string) => void }) {
  const [value, setValue] = useState<string>(initial != null ? String(initial) : "");
  const initialRef = useRef<string>(initial != null ? String(initial) : "");
  // Wenn Parent ein neues initial reinreicht (nach Reload), Draft syncen.
  useEffect(() => {
    const asStr = initial != null ? String(initial) : "";
    setValue(asStr);
    initialRef.current = asStr;
  }, [initial]);
  const commit = () => {
    if (value === initialRef.current) return;
    onSave(value);
    initialRef.current = value;
  };
  return (
    <Input
      type="text"
      inputMode="decimal"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
      }}
      placeholder="—"
      className="h-7 text-xs text-right tabular-nums w-20"
    />
  );
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

  // Aktives Range-Label — sowohl fuer den Print-Header (in der Karte selber
  // gerendert) als auch fuer die PDF-Filename-Ergaenzung nutzbar.
  const rangeLabel = RANGE_OPTIONS.find((o) => o.key === range)?.label ?? "Alle Zeit";
  const todayLabel = new Date().toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric",
  });

  // Drucken: markiert den Body mit der Print-Klasse damit die globale
  // @media-print-Regel die App-Chrome ausblendet, ruft window.print()
  // und raeumt die Klasse im afterprint-Event wieder auf.
  const [printing, setPrinting] = useState(false);
  const handlePrint = () => {
    if (typeof window === "undefined") return;
    setPrinting(true);
    document.body.classList.add("printing-analytics-locations");
    const cleanup = () => {
      document.body.classList.remove("printing-analytics-locations");
      setPrinting(false);
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    // Sicherheitsnetz falls afterprint nie feuert (Firefox in bestimmten
    // Konstellationen, PDF-Preview-Kontext-Bugs).
    window.setTimeout(cleanup, 30_000);
    window.print();
  };

  // PDF: POSTet Range an /api/analytics/locations/pdf, laedt den Blob
  // als Download runter — Pattern analog anderen PDF-Downloads (siehe
  // monatsstunden-table.tsx). Filename kommt aus dem Content-Disposition-
  // Header des Servers, wir setzen zusaetzlich einen Client-Fallback.
  const [pdfLoading, setPdfLoading] = useState(false);
  const handlePdf = async () => {
    if (pdfLoading) return;
    setPdfLoading(true);
    try {
      const p = rangeToParams(range);
      const res = await fetch("/api/analytics/locations/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error || "PDF konnte nicht erstellt werden");
        return;
      }
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `Location-Uebersicht_${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch {
      toast.error("PDF konnte nicht erstellt werden");
    } finally {
      setPdfLoading(false);
    }
  };

  // Firmen-Total fuer die Fuss-Zeile.
  const totals = useMemo(() => {
    return rows.reduce((acc, r) => {
      const umsatz = r.hourly_rate_chf != null ? (r.stempel_minutes / 60) * r.hourly_rate_chf : 0;
      return {
        jobs: acc.jobs + r.job_count,
        geplant: acc.geplant + r.geplant_minutes,
        stempel: acc.stempel + r.stempel_minutes,
        rapport: acc.rapport + r.rapport_minutes,
        // Umsatz + Kosten nur summieren wenn ein Satz gepflegt ist —
        // sonst mischt sich "keine Angabe" (0) in die Summe.
        umsatz: acc.umsatz + umsatz,
        kosten: acc.kosten + (r.hourly_rate_chf != null ? Number(r.vollkosten_chf) : 0),
      };
    }, { jobs: 0, geplant: 0, stempel: 0, rapport: 0, umsatz: 0, kosten: 0 });
  }, [rows]);
  const totalMarge = totals.umsatz - totals.kosten;
  const totalMargePct = totals.umsatz > 0 ? (totalMarge / totals.umsatz) * 100 : null;

  // Optimistic Update + PATCH fuer Stundensatz.
  async function saveRate(location_id: string, raw: string) {
    const parsed = raw.trim() === "" ? null : parseFloat(raw.replace(",", "."));
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 99999)) {
      toast.error("Ungueltiger Stundensatz");
      return;
    }
    setRows((prev) => prev.map((r) => r.location_id === location_id ? { ...r, hourly_rate_chf: parsed } : r));
    const res = await fetch("/api/analytics/locations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location_id, rate: parsed }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      toast.error(json.error || "Speichern fehlgeschlagen");
      // Reload um den echten State wiederherzustellen.
      load();
    }
  }

  return (
    <Card className="bg-card location-overview-print">
      <CardContent className="p-4 space-y-3">
        {/* Print-only Header — wird nur waehrend @media print sichtbar.
            Ersetzt in der Druckansicht Titel + Zeitraum-Toggle durch
            eine ruhige, doku-artige Kopfzeile. */}
        <div className="print-only">
          <h1>Location-Auslastungsuebersicht</h1>
          <p>Zeitraum: {rangeLabel} · Erstellt am {todayLabel}</p>
        </div>

        <div className="flex items-start justify-between gap-3 flex-wrap print-hide">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <MapPin className="h-4 w-4" /> Locations — Auslastungsuebersicht
            </h2>
            <p className="text-xs text-muted-foreground">
              Auftraege, Stunden und Kalkulations-Genauigkeit pro Standort. Sortiert nach gestempelten Stunden.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <div className="flex items-center gap-1">
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
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrint}
                disabled={printing || loading}
                className="kasten kasten-muted inline-flex items-center gap-1.5"
                data-tooltip="Uebersicht drucken"
              >
                {printing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
                Drucken
              </button>
              <button
                type="button"
                onClick={handlePdf}
                disabled={pdfLoading || loading}
                className="kasten kasten-blue inline-flex items-center gap-1.5"
                data-tooltip="Als PDF herunterladen"
              >
                {pdfLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                PDF
              </button>
            </div>
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
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Anzahl abgeschlossener/laufender Auftraege im Zeitraum (ohne Storno/Entwurf)">Auftr.</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Summe aller geplanten Termine">Geplant</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Summe aller abgeschlossenen Stempelungen">Stempel</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Summe der Rapport-Zeilen aus abgeschlossenen Einsatzrapporten">Rapport</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Abweichung Stempel zu Geplant. Positiv = laenger gedauert als kalkuliert.">Δ Kalk.</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Diskrepanz Stempel zu Rapport. Rot wenn > 15% Abweichung.">Δ Rap.</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Was wir dem Kunden pro Personenstunde in Rechnung stellen. Editierbar, gilt fuer die gesamte Historie dieser Location.">Satz CHF/h</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Stempel-Stunden × Satz. Nur wenn Satz hinterlegt.">Umsatz</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Vollkosten: pro Time-Entry der MA-Lohn × (1 + firmen-AG-Anteil), historisch korrekt. AG-Overrides pro MA werden ignoriert (Uebersichts-Naeherung).">Kosten</th>
                  <th className="text-right py-2 px-2 font-medium" data-tooltip="Umsatz − Kosten und Marge in %. Rot wenn Marge negativ.">Marge</th>
                  <th className="text-right py-2 pl-2 pr-1 font-medium" data-tooltip="Datum des letzten Auftrags an dieser Location">Zuletzt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => {
                  const deltaKalk = pctDelta(r.geplant_minutes, r.stempel_minutes);
                  const deltaRap = pctDelta(r.stempel_minutes, r.rapport_minutes);
                  const rapCritical = deltaRap !== null && Math.abs(deltaRap) > 15;
                  const hasRate = r.hourly_rate_chf != null;
                  const stempelH = r.stempel_minutes / 60;
                  const umsatz = hasRate ? stempelH * (r.hourly_rate_chf as number) : null;
                  const kosten = Number(r.vollkosten_chf) || 0;
                  const marge = umsatz != null ? umsatz - kosten : null;
                  const margePct = umsatz != null && umsatz > 0 ? (marge as number) / umsatz * 100 : null;
                  return (
                    <tr key={r.location_id} className="hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]">
                      <td className="py-2 pr-3 font-medium truncate max-w-[180px]" title={r.location_name}>{r.location_name}</td>
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
                      <td className="text-right py-2 px-2 tabular-nums">
                        <RateInput
                          initial={r.hourly_rate_chf}
                          onSave={(v) => saveRate(r.location_id, v)}
                        />
                      </td>
                      <td className="text-right py-2 px-2 tabular-nums">
                        {umsatz != null ? CHF.format(umsatz) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">
                        {kosten > 0 ? CHF.format(kosten) : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className={`text-right py-2 px-2 tabular-nums ${marge === null ? "text-muted-foreground/40" : marge < 0 ? "text-red-600 dark:text-red-400 font-semibold" : "text-emerald-700 dark:text-emerald-400 font-semibold"}`}>
                        {marge === null ? "—" : (
                          <span>
                            {CHF.format(marge)}
                            {margePct != null && (
                              <span className="ml-1 text-[10px] opacity-70">({margePct.toFixed(0)}%)</span>
                            )}
                          </span>
                        )}
                      </td>
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
                  <td colSpan={2}></td>
                  <td></td>
                  <td className="text-right py-2 px-2 tabular-nums">
                    {totals.umsatz > 0 ? CHF.format(totals.umsatz) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="text-right py-2 px-2 tabular-nums text-muted-foreground">
                    {totals.kosten > 0 ? CHF.format(totals.kosten) : <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className={`text-right py-2 px-2 tabular-nums ${totals.umsatz === 0 ? "text-muted-foreground/40" : totalMarge < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                    {totals.umsatz === 0 ? "—" : (
                      <span>
                        {CHF.format(totalMarge)}
                        {totalMargePct !== null && (
                          <span className="ml-1 text-[10px] opacity-70">({totalMargePct.toFixed(0)}%)</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
