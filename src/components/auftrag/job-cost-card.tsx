"use client";

/**
 * PlannedCostBadge — dezente Admin-Pills im Header der Termine-Sektion
 * (Auftrag-Detail):
 *
 *   "~ CHF 1'870"          Personal-Kosten-Prognose: geplante Termine mit
 *                          zugewiesener Person × deren Voll-CHF/h zum
 *                          Termin-Datum (Leo 2026-09-08: "nur die prognose
 *                          bei den terminen, alles andere ist zu viel").
 *   "Gewinn ~ CHF 950"     NUR wenn der Auftrag ein Offerten-PDF in den
 *                          Dokumenten hat (Dateiname enthaelt "offerte"):
 *                          KI-extrahierte Arbeitsstunden-Summe der Offerte
 *                          minus Kosten-Prognose. Gruen = positiv, rot =
 *                          negativ. Keine Offerte → Pill erscheint nicht.
 *
 * EIN fetch fuer beides: /api/admin/job-offer-profit (hat die alte
 * /api/admin/job-costs-Route ersetzt). Self-gating: Non-Admins bekommen
 * 403 und es rendert nichts (Zahlen verlassen den Server nur fuer Admins).
 * Refetcht wenn sich die Termine aendern (refreshKey im Aufrufer).
 * Die Offerten-Analyse ist serverseitig gecacht — der Refetch loest
 * keinen neuen LLM-Call aus, solange die Offerten-Datei dieselbe ist.
 */

import { useEffect, useState } from "react";

interface BadgeData {
  planned: { minutes: number; chf: number };
  offer: { total_arbeit_chf: number; document_name: string } | null;
  profitChf: number | null;
}

const PILL_BASE =
  "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold tabular-nums whitespace-nowrap normal-case tracking-normal";

export function PlannedCostBadge({ jobId, refreshKey }: { jobId: string; refreshKey?: unknown }) {
  const [data, setData] = useState<BadgeData | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/job-offer-profit?jobId=${jobId}`);
        if (!res.ok) return; // 403 fuer Non-Admins → Badge bleibt weg.
        const json = await res.json();
        if (cancelled || !json.success) return;
        setData({
          planned: {
            minutes: json.planned?.minutes ?? 0,
            chf: json.planned?.vollkosten_chf ?? 0,
          },
          offer: json.offer ?? null,
          profitChf: typeof json.profit_chf === "number" ? json.profit_chf : null,
        });
      } catch {
        // still — Ambient-Info.
      }
    })();
    return () => { cancelled = true; };
    // refreshKey: Aufrufer gibt die appointments-Referenz mit — nach jeder
    // Termin-Mutation laedt der Parent neu → neue Referenz → Refetch.
  }, [jobId, refreshKey]);

  if (!data || data.planned.minutes <= 0) return null;

  const hours = (data.planned.minutes / 60).toLocaleString("de-CH", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const chf = (n: number) => Math.round(n).toLocaleString("de-CH");

  const profit = data.profitChf;
  const showProfit = profit !== null && data.offer !== null;
  const profitPositive = (profit ?? 0) >= 0;

  return (
    <>
      <span
        className={`${PILL_BASE} bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300`}
        data-tooltip={`Personal-Kosten-Prognose: ${hours} h zugewiesene Termine × Voll-CHF/h der Mitarbeiter (nur für Admins sichtbar)`}
      >
        ~ CHF {chf(data.planned.chf)}
      </span>
      {showProfit && data.offer && (
        <span
          className={`${PILL_BASE} ${
            profitPositive
              ? "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
              : "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
          }`}
          data-tooltip={`Offerte (Arbeit): CHF ${chf(data.offer.total_arbeit_chf)} − Kosten-Prognose CHF ${chf(data.planned.chf)}. Quelle: ${data.offer.document_name}`}
        >
          Gewinn ~ CHF {chf(profit ?? 0)}
        </span>
      )}
    </>
  );
}
