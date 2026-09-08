"use client";

/**
 * PlannedCostBadge — gruene Kosten-Prognose-Pill im Header der
 * Termine-Sektion (Auftrag-Detail): "~ CHF 1'870" = geplante Termine
 * mit zugewiesener Person × deren Voll-CHF/h zum Termin-Datum.
 * (Leo 2026-09-08: "nur die prognose bei den terminen".)
 *
 * Self-gating: fetcht /api/admin/job-costs — Non-Admins bekommen 403
 * und die Badge rendert nichts (Zahlen verlassen den Server nur fuer
 * Admins). Refetcht wenn sich die Termine aendern (refreshKey =
 * appointments-Referenz im Aufrufer).
 *
 * Historie: Eine "Gewinn"-Zweit-Pill (KI-gelesene Offerten-Arbeits-
 * positionen minus Prognose) wurde am 2026-09-08 auf Leos Wunsch
 * komplett wieder entfernt.
 */

import { useEffect, useState } from "react";

export function PlannedCostBadge({ jobId, refreshKey }: { jobId: string; refreshKey?: unknown }) {
  const [planned, setPlanned] = useState<{ minutes: number; chf: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/job-costs?ids=${jobId}`);
        if (!res.ok) return; // 403 fuer Non-Admins → Badge bleibt weg.
        const json = await res.json();
        if (cancelled || !json.success) return;
        const c = json.costs?.[jobId] as { planned_minutes: number; planned_vollkosten_chf: number } | undefined;
        setPlanned(c ? { minutes: c.planned_minutes, chf: c.planned_vollkosten_chf } : { minutes: 0, chf: 0 });
      } catch {
        // still — Ambient-Info.
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, refreshKey]);

  if (!planned || planned.minutes <= 0) return null;

  const hours = (planned.minutes / 60).toLocaleString("de-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold tabular-nums whitespace-nowrap normal-case tracking-normal bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300"
      data-tooltip={`Personal-Kosten-Prognose: ${hours} h zugewiesene Termine × Voll-CHF/h der Mitarbeiter (nur für Admins sichtbar)`}
    >
      ~ CHF {Math.round(planned.chf).toLocaleString("de-CH")}
    </span>
  );
}
