// POST /api/jobs/[id]/finish-from-rapport
//
// Setzt jobs.status = 'abgeschlossen' nachdem ein Rapport finalisiert
// wurde. Server-seitig via Admin-Client damit RLS auf jobs nicht
// dazwischenfunkt — bisher hat der Direct-Update aus dem Rapport-Modal
// silent failed wenn der User nicht in job_assignments stand (typisch
// fuer Techniker die spontan einsprangen).
//
// Authorization: internes Konto (Portal-Konten schliessen nie Auftraege)
// UND der User muss einen abgeschlossenen Rapport fuer DIESEN Job erstellt
// haben. Sonst kein Access — kein Free-for-all-Endpoint. Rapporte anlegen
// duerfen per RLS nur interne Konten, die den Auftrag sehen (Migration 330).

import { NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const { id: jobId } = await params;

  const admin = createAdminClient();

  // Existiert ein abgeschlossener Rapport vom anfragenden User fuer
  // diesen Job? Nur dann darf er den Job-Status drehen.
  const { data: report, error: reportErr } = await admin
    .from("service_reports")
    .select("id, status, created_by")
    .eq("job_id", jobId)
    .eq("status", "abgeschlossen")
    // dev-mode: effective user
    .eq("created_by", auth.effectiveUserId)
    .limit(1)
    .maybeSingle();
  if (reportErr) return NextResponse.json({ success: false, error: reportErr.message }, { status: 500 });
  if (!report) {
    return NextResponse.json({ success: false, error: "Kein abgeschlossener Rapport vom User für diesen Auftrag" }, { status: 403 });
  }

  // Job auf abgeschlossen setzen (idempotent — wenn schon abgeschlossen,
  // ist die UPDATE ein no-op).
  const { error: jobErr, count } = await admin
    .from("jobs")
    .update({ status: "abgeschlossen" }, { count: "exact" })
    .eq("id", jobId);
  if (jobErr) return NextResponse.json({ success: false, error: jobErr.message }, { status: 500 });
  if (count === 0) {
    return NextResponse.json({ success: false, error: "Auftrag existiert nicht" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
