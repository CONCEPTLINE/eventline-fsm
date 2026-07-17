import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requireUser } from "@/lib/api-auth";
import { notifyPartnerTerminZugewiesen } from "@/lib/notification-service";
import { logError } from "@/lib/log";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { assignedTo, title, date, time, endTime, jobTitle, creatorName, jobId } = await request.json();

  if (!assignedTo) return NextResponse.json({ success: false });

  const supabase = createAdminClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email")
    .eq("id", assignedTo)
    .single();

  if (!profile?.email) return NextResponse.json({ success: false });

  // Partner-Notify: wenn der Job zu einer Partner-Location gehoert, ALLE
  // Partner-User dieser Location ueber die Techniker-Zuteilung informieren.
  // Mapping: profiles.partner_location_id = jobs.location_id.
  // Respektiert user_notification_settings.channels.
  if (jobId && typeof jobId === "string") {
    try {
      const { data: job } = await supabase
        .from("jobs")
        .select("title, location_id")
        .eq("id", jobId)
        .maybeSingle();
      const locationId = (job as { location_id?: string | null } | null)?.location_id ?? null;
      if (locationId) {
        const { data: partnerProfiles } = await supabase
          .from("profiles")
          .select("id")
          .eq("partner_location_id", locationId)
          .eq("is_active", true);
        const recipients = ((partnerProfiles ?? []) as { id: string }[]).map((p) => p.id);
        if (recipients.length > 0) {
          const apptStart = new Date(`${date}T${time}:00`).toISOString();
          const apptEnd = endTime ? new Date(`${date}T${endTime}:00`).toISOString() : null;
          await notifyPartnerTerminZugewiesen(supabase, {
            recipients,
            jobId,
            jobTitle: (job as { title?: string })?.title ?? jobTitle ?? "Anfrage",
            apptTitle: title,
            apptStart,
            apptEnd,
            assigneeName: profile.full_name ?? "Techniker",
          });
        }
      }
    } catch (e) {
      logError("assign-notify.partner", e, { jobId });
    }
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ success: false });

  const resend = new Resend(resendKey);

  const dateStr = new Date(date + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  try {
    await resend.emails.send({
      from: "EVENTLINE FSM <noreply@eventline-basel.com>",
      to: profile.email,
      subject: `Neuer Termin: ${title} – ${dateStr}`,
      html: `
        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
            <h2 style="color:white;margin:0;font-size:16px">EVENTLINE GmbH</h2>
          </div>
          <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
            <p style="margin:0 0 12px">Hallo ${profile.full_name},</p>
            <p style="margin:0 0 16px">Dir wurde ein neuer Termin zugewiesen:</p>
            <div style="background:#f0fdf4;padding:16px;border-radius:8px;border-left:4px solid #16a34a;margin:0 0 16px">
              <p style="margin:0 0 4px;font-weight:600;font-size:16px">${title}</p>
              <p style="margin:0 0 4px;color:#666">${dateStr}</p>
              <p style="margin:0 0 4px;color:#666">${time} – ${endTime} Uhr</p>
              ${jobTitle ? `<p style="margin:4px 0 0;color:#3b82f6;font-size:13px">Auftrag: ${jobTitle}</p>` : ""}
            </div>
            <p style="margin:0 0 4px;color:#999;font-size:13px">Zugewiesen von ${creatorName}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
            <p style="margin:0;color:#bbb;font-size:11px">EVENTLINE GmbH · St. Jakobs-Strasse 200 · CH-4052 Basel</p>
          </div>
        </div>
      `,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false });
  }
}
