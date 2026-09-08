// GET /api/admin/job-costs?ids=<uuid,uuid,...>
//
// Admin-only Kosten-PROGNOSE pro Auftrag: geplante Termine mit
// zugewiesener Person × deren Voll-CHF/h zum Termin-Datum. Angezeigt
// als "~ CHF X" im Header der Termine-Sektion (PlannedCostBadge).
// Ist-Kosten wurden bewusst entfernt (Leo 2026-09-08: "nur die
// prognose bei den terminen, alles andere ist zu viel") — die
// Ist-Zahlen stehen im Standort-Rapport.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { computeJobPlannedCosts } from "@/lib/job-costs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  // Admin-Gate: Personalkosten sind sensibel (enthalten Rueckschluesse auf
  // Loehne). Rolle des EFFEKTIVEN Users pruefen (View-As-konsistent).
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (profile?.role !== "admin") {
    return NextResponse.json({ success: false, error: "Nur für Administratoren" }, { status: 403 });
  }

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
