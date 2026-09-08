"use client";

/**
 * PlannedCostBadge — dezente Personal-Kosten-Prognose im Header der
 * Termine-Sektion (Auftrag-Detail). "~ CHF 1'870" = geplante Termine
 * mit zugewiesener Person × deren Voll-CHF/h zum Termin-Datum.
 *
 * Bewusst NUR diese eine Zahl (Leo 2026-09-08: "nur die prognose bei
 * den terminen, alles andere ist zu viel") — keine Ist-Kosten, keine
 * eigene Karte, keine Listen-Anzeige.
 *
 * Self-gating: fetcht /api/admin/job-costs — Non-Admins bekommen 403
 * und die Badge rendert nichts (Zahlen verlassen den Server nur fuer
 * Admins). Refetcht wenn sich die Termine aendern (appointments-Dep
 * im Aufrufer via refreshKey).
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
    // refreshKey: Aufrufer gibt die appointments-Referenz mit — nach jeder
    // Termin-Mutation laedt der Parent neu → neue Referenz → Refetch.
  }, [jobId, refreshKey]);

  if (!planned || planned.minutes <= 0) return null;

  const hours = (planned.minutes / 60).toLocaleString("de-CH", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <span
      className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap normal-case tracking-normal font-normal"
      data-tooltip={`Personal-Kosten-Prognose: ${hours} h zugewiesene Termine × Voll-CHF/h der Mitarbeiter (nur für Admins sichtbar)`}
    >
      ~ CHF {Math.round(planned.chf).toLocaleString("de-CH")}
    </span>
  );
}
