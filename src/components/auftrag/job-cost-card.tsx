"use client";

/**
 * JobCostCard — Admin-Kostenvorschau im Auftrag-Detail (Übersicht-Tab).
 *
 * Zeigt kompakt die Personal-Vollkosten des Auftrags:
 *   Ist       — gestempelte + rapportierte Stunden × historischem Voll-CHF/h
 *   Prognose  — geplante Termine (zugewiesene Personen) × Voll-CHF/h
 *
 * Self-gating: fetcht /api/admin/job-costs — Non-Admins bekommen 403 und
 * die Karte rendert schlicht nichts (kein Prop-Threading, kein Leak;
 * die Zahlen kommen nie beim Client an).
 */

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";

interface CostData {
  minutes: number;
  vollkosten_chf: number;
  planned_minutes: number;
  planned_vollkosten_chf: number;
}

function fmtChf(v: number): string {
  return Math.round(v).toLocaleString("de-CH");
}

function fmtH(mins: number): string {
  return (mins / 60).toLocaleString("de-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function JobCostCard({ jobId }: { jobId: string }) {
  const [cost, setCost] = useState<CostData | null>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/job-costs?ids=${jobId}`);
        if (!res.ok) return; // 403 fuer Non-Admins → Karte bleibt weg.
        const json = await res.json();
        if (cancelled || !json.success) return;
        setAllowed(true);
        setCost((json.costs?.[jobId] as CostData | undefined) ?? { minutes: 0, vollkosten_chf: 0, planned_minutes: 0, planned_vollkosten_chf: 0 });
      } catch {
        // still — Ambient-Info.
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  if (!allowed || !cost) return null;

  const hasIst = cost.minutes > 0;
  const hasPlanned = cost.planned_minutes > 0;

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <Wallet className="h-4 w-4 text-accent" />
        Personal-Vollkosten
        <span className="normal-case font-normal text-muted-foreground/70">· nur für Admins sichtbar</span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-6 gap-y-1 tabular-nums">
        <div data-tooltip="Gestempelte + rapportierte Stunden × Voll-CHF/h zum jeweiligen Datum (Brutto × (1 + AG-Anteil %))">
          <span className="text-[11px] text-muted-foreground mr-1.5">Ist</span>
          {hasIst ? (
            <>
              <span className="text-lg font-bold">CHF {fmtChf(cost.vollkosten_chf)}</span>
              <span className="text-xs text-muted-foreground ml-1.5">{fmtH(cost.minutes)} h</span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">— noch keine Zeit erfasst</span>
          )}
        </div>
        <div data-tooltip="Geplante Termine mit zugewiesener Person × deren Voll-CHF/h zum Termin-Datum. Termine ohne Zuweisung fliessen nicht ein.">
          <span className="text-[11px] text-muted-foreground mr-1.5">Prognose</span>
          {hasPlanned ? (
            <>
              <span className="text-lg font-bold">~ CHF {fmtChf(cost.planned_vollkosten_chf)}</span>
              <span className="text-xs text-muted-foreground ml-1.5">{fmtH(cost.planned_minutes)} h geplant</span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">— keine zugewiesenen Termine</span>
          )}
        </div>
      </div>
    </section>
  );
}
