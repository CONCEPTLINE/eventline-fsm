// GET /api/lieferant/anfragen/[jobId]/plan — Raumplan (read-only) fuer das
// Lieferanten-Review: Grundriss-Unterlage der Location (signed URL) +
// platzierte Plan-Objekte + platzierte Technik-Positionen. Der Lieferant
// SIEHT den Plan und kommentiert — bearbeiten kann nur EVENTLINE.
// Ohne kalibrierten Massstab: ppm = null → das Portal blendet «Messen» aus
// (wie die Firmenseite; keine geratenen 40 px/m).

import { NextRequest, NextResponse } from "next/server";
import { requireLieferantPortal, lieferantAuftrag } from "@/lib/technik-server";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ success: false, error: "Ungültige ID" }, { status: 400 });

  // Zugriff erst nach der Anfrage; geloeschte Auftraege = 404.
  const zugriff = await lieferantAuftrag(admin, jobId, lieferantId);
  if (!zugriff.ok) return zugriff.antwort;

  try {
    const { data: job, error: jErr } = await admin
      .from("jobs")
      .select("location_id")
      .eq("id", jobId)
      .maybeSingle();
    if (jErr) throw jErr;
    if (!job?.location_id) return NextResponse.json({ success: true, hatPlan: false });

    const { data: loc, error: lErr } = await admin
      .from("locations")
      .select("plan_unterlage")
      .eq("id", job.location_id)
      .maybeSingle();
    if (lErr) throw lErr;
    const unterlage = loc?.plan_unterlage as { path?: string; breite_px?: number; hoehe_px?: number; px_pro_meter?: number | null } | null;
    if (!unterlage?.path || !unterlage.breite_px || !unterlage.hoehe_px) {
      return NextResponse.json({ success: true, hatPlan: false });
    }

    const [signed, objekte, positionen] = await Promise.all([
      admin.storage.from("documents").createSignedUrl(unterlage.path, 3600),
      admin
        .from("job_plan_objekte")
        .select("id, typ, label, x, y, rot, breite, tiefe")
        .eq("job_id", jobId),
      admin
        .from("job_technik_positionen")
        .select("id, bezeichnung, menge, masse, position")
        .eq("job_id", jobId),
    ]);
    if (objekte.error) throw objekte.error;
    if (positionen.error) throw positionen.error;
    if (!signed.data?.signedUrl) return NextResponse.json({ success: true, hatPlan: false });

    const ppm = typeof unterlage.px_pro_meter === "number" && unterlage.px_pro_meter > 0 ? unterlage.px_pro_meter : null;
    return NextResponse.json({
      success: true,
      hatPlan: true,
      unterlageUrl: signed.data.signedUrl,
      breitePx: unterlage.breite_px,
      hoehePx: unterlage.hoehe_px,
      ppm,
      objekte: objekte.data ?? [],
      positionen: positionen.data ?? [],
    });
  } catch (e) {
    logError("api.lieferant.anfragen.plan", e, { jobId });
    return NextResponse.json({ success: false, error: "Laden fehlgeschlagen" }, { status: 500 });
  }
}
