// GET /api/admin/job-costs?ids=<uuid,uuid,...>
//
// Admin-only Kostenvorschau fuer die Auftraege-Liste: Personal-Vollkosten
// pro Auftrag (Stempel + Rapport-Zeiten × historischem Voll-CHF/h).
// Batch bis 200 IDs — die Liste laedt einmal pro Segment/Seite, nicht
// pro Zeile. Semantik identisch zum Location-Report (src/lib/job-costs.ts).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { computeJobPersonnelCosts, computeJobPlannedCosts } from "@/lib/job-costs";

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
    const [istMap, plannedMap] = await Promise.all([
      computeJobPersonnelCosts(admin, ids),
      computeJobPlannedCosts(admin, ids),
    ]);
    const costs: Record<string, { minutes: number; vollkosten_chf: number; planned_minutes: number; planned_vollkosten_chf: number }> = {};
    for (const id of ids) {
      const ist = istMap.get(id);
      const planned = plannedMap.get(id);
      if (!ist && !planned) continue;
      costs[id] = {
        minutes: ist?.minutes ?? 0,
        vollkosten_chf: Math.round((ist?.vollkosten_chf ?? 0) * 100) / 100,
        planned_minutes: planned?.minutes ?? 0,
        planned_vollkosten_chf: Math.round((planned?.vollkosten_chf ?? 0) * 100) / 100,
      };
    }
    return NextResponse.json({ success: true, costs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Berechnung fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
