// GET /api/admin/job-costs?ids=<uuid,uuid,...>
//
// Kosten-PROGNOSE pro Auftrag: geplante Termine mit
// zugewiesener Person × deren Voll-CHF/h zum Termin-Datum. Angezeigt
// als gruene Pill "~ CHF X" im Header der Termine-Sektion
// (PlannedCostBadge in job-cost-card.tsx).
//
// Permission: abrechnung:edit (Admins passen via has_permission() durch) —
// Kosten-Prognosen sind Abrechnungs-Domäne, kein harter Admin-Check mehr.
//
// Historie: Ein Offerten-Gewinn-Feature (KI-Analyse der Offerten-PDFs)
// lebte kurz in /api/admin/job-offer-profit und wurde am 2026-09-08 auf
// Leos Wunsch komplett entfernt — diese Route ist wieder die schlanke
// Prognose-Quelle.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { computeJobPlannedCosts } from "@/lib/job-costs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const auth = await requirePermission("abrechnung:edit");
  if (auth.error) return auth.error;

  const admin = createAdminClient();

  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
  if (ids.length === 0) return NextResponse.json({ success: true, costs: {} });
  if (ids.length > 200) {
    return NextResponse.json({ success: false, error: "Zu viele IDs (max. 200)" }, { status: 400 });
  }

  try {
    const plannedMap = await computeJobPlannedCosts(admin, ids);
    const costs: Record<string, { planned_minutes: number; planned_vollkosten_chf: number }> = {};
    for (const [id, planned] of plannedMap) {
      costs[id] = {
        planned_minutes: planned.minutes,
        planned_vollkosten_chf: Math.round(planned.vollkosten_chf * 100) / 100,
      };
    }
    return NextResponse.json({ success: true, costs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Berechnung fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
