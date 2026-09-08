// GET /api/admin/job-offer-profit?jobId=<uuid>
//
// Admin-only: Kosten-Prognose + Offerten-Gewinn fuer EINEN Auftrag.
// Ersetzt /api/admin/job-costs (einziger Nutzer war die PlannedCostBadge —
// die zieht jetzt hierher um, EIN fetch fuer beides).
//
//   planned     — geplante Termine × Voll-CHF/h (computeJobPlannedCosts,
//                 identisch zur bisherigen "~ CHF X"-Pill)
//   offer       — KI-extrahierte Arbeitsstunden-Summe aus dem neuesten
//                 Offerten-PDF des Auftrags (Cache: job_offer_analysis,
//                 LLM nur bei neuer/anderer Offerten-Datei) | null
//   profit_chf  — offer.total_arbeit_chf − planned.vollkosten_chf | null
//   offer_error — optional: warum keine Offerten-Analyse moeglich war
//                 (z.B. "ANTHROPIC_API_KEY fehlt"); planned kommt trotzdem,
//                 damit die Kosten-Pill nie am Offerten-Teil scheitert.
//
// Admin-Gate wie die alte job-costs-Route: Rolle des EFFEKTIVEN Users
// (View-As-konsistent) — Marge/Loehne sind sensibel.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { computeJobPlannedCosts } from "@/lib/job-costs";
import { getOfferAnalysis } from "@/lib/offer-analysis";

// Erst-Analyse einer Offerte (PDF → Claude API) kann >10s dauern.
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (profile?.role !== "admin") {
    return NextResponse.json({ success: false, error: "Nur für Administratoren" }, { status: 403 });
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  if (!UUID_RE.test(jobId)) {
    return NextResponse.json({ success: false, error: "Ungültige jobId" }, { status: 400 });
  }

  try {
    const [plannedMap, offerResult] = await Promise.all([
      computeJobPlannedCosts(admin, [jobId]),
      getOfferAnalysis(admin, jobId),
    ]);
    const planned = plannedMap.get(jobId) ?? { minutes: 0, vollkosten_chf: 0 };
    const vollkosten = Math.round(planned.vollkosten_chf * 100) / 100;

    const offer = offerResult.offer;
    // Gewinn nur wenn die Offerte tatsaechlich Arbeitspositionen enthaelt —
    // total 0 wuerde sonst "Gewinn = −Kosten" anzeigen (irrefuehrend).
    const profit =
      offer && offer.total_arbeit_chf > 0
        ? Math.round((offer.total_arbeit_chf - vollkosten) * 100) / 100
        : null;

    return NextResponse.json({
      success: true,
      planned: { minutes: planned.minutes, vollkosten_chf: vollkosten },
      offer: offer
        ? {
            total_arbeit_chf: offer.total_arbeit_chf,
            document_name: offer.document_name,
            analyzed_at: offer.analyzed_at,
          }
        : null,
      profit_chf: profit,
      ...(offerResult.error ? { offer_error: offerResult.error } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Berechnung fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
