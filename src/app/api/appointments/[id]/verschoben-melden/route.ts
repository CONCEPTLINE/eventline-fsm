import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { notifyPartnerTerminVerschoben } from "@/lib/notification-service";
import { logError } from "@/lib/log";

// POST { vorher_start?, vorher_end? }
//
// Meldet dem Partner, dass EVENTLINE einen Termin seiner Anfrage zeitlich
// verschoben hat. Wird von den internen Termin-Edit-Pfaden NACH dem
// erfolgreichen Update gerufen, wenn sich die Zeit geaendert hat.
//
// Der Server verifiziert selbst: Termin existiert, zeit_modus =
// 'verschiebbar' (nur dort ist Verschieben ohne Partner-Freigabe erlaubt —
// und genau dort will der Partner es mitbekommen, Doppelbuchungs-Schutz),
// Job gehoert zu einer Partner-Location. vorher_* dient nur dem Mail-Text.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("kalender:create");
  if (auth.error) return auth.error;
  const { id } = await params;

  let vorherStart: string | null = null;
  let vorherEnd: string | null = null;
  try {
    const body = await request.json();
    if (typeof body?.vorher_start === "string") vorherStart = body.vorher_start;
    if (typeof body?.vorher_end === "string") vorherEnd = body.vorher_end;
  } catch { /* leerer Body ist ok */ }

  try {
    const admin = createAdminClient();
    const { data: appt } = await admin
      .from("job_appointments")
      .select("id, title, start_time, end_time, zeit_modus, job_id")
      .eq("id", id)
      .maybeSingle();
    if (!appt || appt.zeit_modus !== "verschiebbar" || !appt.job_id) {
      return NextResponse.json({ success: true, informiert: 0 });
    }
    const { data: job } = await admin
      .from("jobs")
      .select("title, location_id")
      .eq("id", appt.job_id)
      .maybeSingle();
    if (!job?.location_id) {
      return NextResponse.json({ success: true, informiert: 0 });
    }
    const { data: partnerProfiles } = await admin
      .from("profiles")
      .select("id")
      .eq("partner_location_id", job.location_id)
      .eq("is_active", true);
    const recipients = ((partnerProfiles ?? []) as { id: string }[]).map((p) => p.id);
    if (recipients.length === 0) {
      return NextResponse.json({ success: true, informiert: 0 });
    }
    await notifyPartnerTerminVerschoben(admin, {
      recipients,
      jobId: appt.job_id,
      jobTitle: job.title ?? "Anfrage",
      apptTitle: appt.title,
      neuStart: appt.start_time,
      neuEnd: appt.end_time,
      vorherStart,
      vorherEnd,
    });
    return NextResponse.json({ success: true, informiert: recipients.length });
  } catch (e) {
    logError("appointments.verschoben-melden", e, { apptId: id });
    return NextResponse.json({ success: false, error: "Meldung fehlgeschlagen" }, { status: 500 });
  }
}
