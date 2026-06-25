// GET /api/reports/[id]/pdf — Einzel-Rapport als PDF.
// Logik (PDF-Build) liegt in src/lib/build-rapport-pdf.ts und wird mit
// /api/reports/export-zip geteilt.

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { buildRapportPdf, type RapportJobInfo } from "@/lib/build-rapport-pdf";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id } = await params;

  // User-Client (mit Session-Cookie) damit RLS auf service_reports
  // greift — der User sieht nur Reports zu denen er berechtigt ist.
  const userClient = await createClient();
  const { data: report } = await userClient
    .from("service_reports")
    .select("*, job:jobs(title, job_number, verwaltungsaufwand, verwaltungsaufwand_minutes, customer:customers(name, address_street, address_zip, address_city), location:locations(name))")
    .eq("id", id)
    .single();

  if (!report) {
    return NextResponse.json({ error: "Rapport nicht gefunden oder keine Berechtigung" }, { status: 404 });
  }

  // Service-Role fuer Signatur-Downloads (Storage-RLS koennte sonst
  // blocken obwohl der Rapport sichtbar ist).
  const admin = createAdminClient();
  const pdfBuffer = await buildRapportPdf(report, (report.job as RapportJobInfo | null) ?? null, admin);

  const jobNum = (report.job as { job_number?: number } | null)?.job_number;
  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Rapport_${jobNum ?? id}.pdf"`,
    },
  });
}
