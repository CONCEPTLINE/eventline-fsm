import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { notifyPartnerTerminZugewiesen } from "@/lib/notification-service";
import { logError } from "@/lib/log";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMail, mailRahmen, isMailConfigured } from "@/lib/mail";

export async function POST(request: Request) {
  // Audit-Fix g1: vorher nur requireUser() — jeder eingeloggte User konnte
  // fremde Mitarbeiter mit gefaelschten Terminen anschreiben (Phishing-
  // Vector via client-kontrolliertem assignedTo/Titel/Datum). Jetzt
  // kalender:create-Gate (gleiche Permission wie fuer Termin-Anlage im UI).
  const auth = await requirePermission("kalender:create");
  if (auth.error) return auth.error;
  const { assignedTo, title, date, time, endTime, jobTitle, creatorName, jobId } = await request.json();

  if (!assignedTo) return NextResponse.json({ success: false });

  const supabase = createAdminClient();
  const company = await loadCompanySettings(supabase);

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

  if (!isMailConfigured()) return NextResponse.json({ success: false });

  const dateStr = new Date(date + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const res = await sendMail({
    to: profile.email,
    subject: `Neuer Termin: ${title} – ${dateStr}`,
    html: mailRahmen({
      titel: company.name,
      inhaltHtml: `
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
        <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
      `,
    }),
  });
  return NextResponse.json({ success: res.ok });
}
