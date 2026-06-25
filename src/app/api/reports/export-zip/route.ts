// GET /api/reports/export-zip?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Bulk-Download aller Rapporte in einem Zeitraum als ZIP. Filter:
// report_date >= from AND report_date <= to AND status = 'abgeschlossen'
// (Entwuerfe machen im Archiv-Export keinen Sinn).
//
// Permission: 'auftraege:see-all' (sieht eh schon alle Auftraege) oder
// admin. Sonst koennte ein Techniker im Zweifel ueber den Endpoint
// Reports anderer MA exfiltrieren.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api-auth";
import { buildRapportPdf, rapportFilename, type RapportJobInfo, type RapportReportRow } from "@/lib/build-rapport-pdf";
import JSZip from "jszip";
import { logError } from "@/lib/log";

const HARD_LIMIT = 500;

export async function GET(request: Request) {
  const auth = await requirePermission("auftraege:see-all");
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: "from/to im Format YYYY-MM-DD erforderlich" }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: "'from' liegt nach 'to'" }, { status: 400 });
  }

  // User-Client fuer Liste (RLS macht Plausi-Check zusaetzlich), Admin
  // fuer Storage-Signatur-Downloads im PDF-Build.
  const userClient = await createClient();
  const admin = createAdminClient();

  const { data: reports, error } = await userClient
    .from("service_reports")
    .select("*, job:jobs(title, job_number, verwaltungsaufwand, customer:customers(name, address_street, address_zip, address_city), location:locations(name))")
    .gte("report_date", from)
    .lte("report_date", to)
    .eq("status", "abgeschlossen")
    .order("report_date", { ascending: true })
    .limit(HARD_LIMIT + 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!reports || reports.length === 0) {
    return NextResponse.json({ error: "Keine Rapporte im Zeitraum" }, { status: 404 });
  }
  if (reports.length > HARD_LIMIT) {
    return NextResponse.json({
      error: `Zu viele Rapporte (${reports.length}+). Bitte Zeitraum einschraenken (max ${HARD_LIMIT}).`,
    }, { status: 413 });
  }

  const zip = new JSZip();
  let okCount = 0;
  const failed: string[] = [];

  for (const r of reports as Array<RapportReportRow & { job: RapportJobInfo | null }>) {
    try {
      const pdf = await buildRapportPdf(r, r.job, admin);
      const filename = rapportFilename(r, r.job);
      zip.file(filename, pdf);
      okCount++;
    } catch (e) {
      failed.push(r.id);
      logError("reports.export-zip.build", e, { reportId: r.id });
    }
  }

  // Mini-README im ZIP — sonst weiss niemand was er da bekommen hat.
  const readme =
    `EVENTLINE FSM — Rapport-Export\n` +
    `Zeitraum: ${from} bis ${to}\n` +
    `Rapporte (abgeschlossen): ${okCount}\n` +
    (failed.length > 0 ? `Fehler bei ${failed.length} Rapport(en) — IDs:\n${failed.join("\n")}\n` : "") +
    `Generiert: ${new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}\n`;
  zip.file("README.txt", readme);

  const arrayBuf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const filename = `Rapporte_${from}_bis_${to}.zip`;

  // Next: NextResponse braucht BodyInit — Uint8Array ist akzeptiert,
  // TypeScript-Typing kennt die ArrayBufferView-Variante nicht immer.
  return new NextResponse(arrayBuf as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
