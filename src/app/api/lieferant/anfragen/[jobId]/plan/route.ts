// GET /api/lieferant/anfragen/[jobId]/plan — Raumplan (read-only) fuer das
// Lieferanten-Review: Grundriss-Unterlage der Location (signed URL) +
// platzierte Plan-Objekte + platziertes Material. Der Lieferant SIEHT den
// Plan und kommentiert — bearbeiten kann nur EVENTLINE (bewusst, sonst
// Editier-Konflikte bevor der Kernprozess sitzt).

import { NextRequest, NextResponse } from "next/server";
import { requireLieferantPortal } from "@/lib/technik-server";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ success: false, error: "Ungültige ID" }, { status: 400 });

  const { data: zuw } = await admin
    .from("job_lieferanten")
    .select("id")
    .eq("job_id", jobId)
    .eq("lieferant_id", lieferantId)
    .maybeSingle();
  if (!zuw) return NextResponse.json({ success: false, error: "Kein Zugriff" }, { status: 403 });

  try {
    const { data: job } = await admin
      .from("jobs")
      .select("location_id")
      .eq("id", jobId)
      .maybeSingle();
    if (!job?.location_id) return NextResponse.json({ success: true, hatPlan: false });

    const { data: loc } = await admin
      .from("locations")
      .select("plan_unterlage")
      .eq("id", job.location_id)
      .maybeSingle();
    const unterlage = loc?.plan_unterlage as { path?: string; breite_px?: number; hoehe_px?: number; px_pro_meter?: number | null } | null;
    if (!unterlage?.path || !unterlage.breite_px || !unterlage.hoehe_px) {
      return NextResponse.json({ success: true, hatPlan: false });
    }

    const [{ data: signed }, { data: objekte }, { data: material }] = await Promise.all([
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
    if (!signed?.signedUrl) return NextResponse.json({ success: true, hatPlan: false });

    return NextResponse.json({
      success: true,
      hatPlan: true,
      unterlageUrl: signed.signedUrl,
      breitePx: unterlage.breite_px,
      hoehePx: unterlage.hoehe_px,
      ppm: unterlage.px_pro_meter ?? 40,
      objekte: objekte ?? [],
      material: material ?? [],
    });
  } catch (e) {
    logError("api.lieferant.anfragen.plan", e, { jobId });
    return NextResponse.json({ success: false, error: "Laden fehlgeschlagen" }, { status: 500 });
  }
}
