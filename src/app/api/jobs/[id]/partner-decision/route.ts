import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { notifyPartnerAnfrageBestaetigt, notifyPartnerAnfrageAbgelehnt } from "@/lib/notification-service";

// POST /api/jobs/[id]/partner-decision
// Body: { decision: "accept" | "reject", message?: string }
//
// Admin-Aktion: Partner-Anfrage annehmen (-> status='offen') oder ablehnen
// (-> status='storniert' + partner_response_message als Grund).
// Audit-Trail: accepted_by/at oder rejected_by/at gesetzt.
//
// Permission: auftraege:edit (Admin/Lead haben das per Default).
//
// Benachrichtigung: notifyPartnerAnfrage(Bestaetigt|Abgelehnt) im
// notification-service — respektiert user_notification_settings.channels
// (der Partner steuert Mail/Push/In-App pro Event selber im Konto).

interface Body {
  decision?: unknown;
  message?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id } = await params;

  const body = (await request.json().catch(() => null)) as Body | null;
  const decision = body?.decision;
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (decision !== "accept" && decision !== "reject") {
    return NextResponse.json({ success: false, error: "decision muss 'accept' oder 'reject' sein" }, { status: 400 });
  }
  if (decision === "reject" && !message) {
    return NextResponse.json({ success: false, error: "Bei Ablehnung ist ein Grund Pflicht" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Auch den Ersteller-Profil-Datensatz (email + full_name) gleich
  // mitziehen damit wir die Decision-Mail ohne zweiten Round-Trip
  // versenden koennen.
  const { data: existing } = await admin
    .from("jobs")
    .select("id, status, created_by, title, start_date, end_date, creator:profiles!created_by(full_name, email)")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ success: false, error: "Anfrage nicht gefunden" }, { status: 404 });
  }
  if (existing.status !== "partner_anfrage") {
    return NextResponse.json({ success: false, error: "Anfrage ist nicht mehr im Status 'partner_anfrage'" }, { status: 400 });
  }

  const now = new Date().toISOString();
  type CreatorRel = { full_name: string; email: string | null } | { full_name: string; email: string | null }[] | null;
  const creatorRel = (existing as { creator?: CreatorRel }).creator;
  const creator = Array.isArray(creatorRel) ? creatorRel[0] ?? null : creatorRel;

  const recipientId = (existing as { created_by?: string | null }).created_by ?? null;
  void creator; // (creator wurde vorher fuer die Inline-Mail benoetigt — laeuft jetzt via notification-service)

  if (decision === "accept") {
    const { error } = await admin
      .from("jobs")
      .update({
        status: "offen",
        accepted_by: auth.user.id,
        accepted_at: now,
        partner_response_message: message || null,
      })
      .eq("id", id);
    if (error) {
      logError("api.jobs.partner-decision.accept", error, { jobId: id });
      return NextResponse.json({ success: false, error: "Annahme fehlgeschlagen" }, { status: 500 });
    }
    if (recipientId) {
      await notifyPartnerAnfrageBestaetigt(admin, {
        recipients: [recipientId],
        jobId: id,
        jobTitle: existing.title,
        jobStart: existing.start_date,
        jobEnd: existing.end_date,
        message: message || null,
      });
    }
    return NextResponse.json({ success: true });
  }

  // reject
  const { error } = await admin
    .from("jobs")
    .update({
      status: "storniert",
      rejected_by: auth.user.id,
      rejected_at: now,
      cancelled_at: now,
      cancelled_by: auth.user.id,
      cancellation_reason: message,
      partner_response_message: message,
    })
    .eq("id", id);
  if (error) {
    logError("api.jobs.partner-decision.reject", error, { jobId: id });
    return NextResponse.json({ success: false, error: "Ablehnung fehlgeschlagen" }, { status: 500 });
  }
  if (recipientId) {
    await notifyPartnerAnfrageAbgelehnt(admin, {
      recipients: [recipientId],
      jobId: id,
      jobTitle: existing.title,
      jobStart: existing.start_date,
      jobEnd: existing.end_date,
      message,
    });
  }
  return NextResponse.json({ success: true });
}

