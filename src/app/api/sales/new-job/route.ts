import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requireUser } from "@/lib/api-auth";
import { appUrl } from "@/lib/app-url";
import { ADMIN_NOTIFICATION_EMAIL } from "@/lib/constants";
import { notifySystem } from "@/lib/notification-service";
import { loadCompanySettings, formatMailFooter, formatMailFrom } from "@/lib/company-settings";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { jobNumber, jobId, title, firma, ansprechperson, email, telefon, startDate, endDate, creatorName } = await request.json();

  const resendKey = process.env.RESEND_API_KEY;
  const supabase = createAdminClient();

  // In-App Notification an den primaeren Admin (via Service =>
  // user_notification_settings werden respektiert).
  const { data: admin } = await supabase.from("profiles").select("id").eq("email", ADMIN_NOTIFICATION_EMAIL).single();
  if (admin?.id) {
    await notifySystem(supabase, {
      recipients: [admin.id],
      title: `Neuer Auftrag aus Vertrieb: INT-${jobNumber}`,
      message: `${firma} — ${title}${creatorName ? ` (erstellt von ${creatorName})` : ""}`,
      link: `/auftraege/${jobId}`,
    });
  }

  if (!resendKey) return NextResponse.json({ success: true, note: "No email key" });
  const resend = new Resend(resendKey);
  const company = await loadCompanySettings(supabase);

  const formatDateCH = (d: string, opts?: Intl.DateTimeFormatOptions) => {
    if (!d) return "";
    // timeZone Europe/Zurich zwingend — d kann timestamptz sein.
    return new Date(d).toLocaleDateString("de-CH", {
      timeZone: "Europe/Zurich",
      ...(opts || { day: "numeric", month: "long", year: "numeric" }),
    });
  };
  const dateStr = startDate
    ? formatDateCH(startDate, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : "—";
  const endStr = endDate ? formatDateCH(endDate) : "";

  try {
    await resend.emails.send({
      from: formatMailFrom(company, "noreply@eventline-basel.com"),
      to: ADMIN_NOTIFICATION_EMAIL,
      subject: `🎉 Neuer Auftrag aus Vertrieb: INT-${jobNumber} — ${firma}`,
      html: `
        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#16a34a;padding:20px 24px;border-radius:12px 12px 0 0">
            <h2 style="color:white;margin:0;font-size:16px">🎉 Wir haben einen Auftrag bekommen!</h2>
          </div>
          <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
            <p style="margin:0 0 16px">Aus dem Vertrieb wurde ein neuer Auftrag erstellt:</p>

            <div style="background:#f0fdf4;padding:16px;border-radius:8px;border-left:4px solid #16a34a;margin:0 0 16px">
              <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#16a34a;text-transform:uppercase;letter-spacing:0.5px">Auftrag-Nr.</p>
              <p style="margin:0 0 8px;font-family:monospace;font-size:15px;font-weight:700;color:#1a1a1a">INT-${jobNumber}</p>
              <p style="margin:0;font-weight:600;font-size:16px;color:#1a1a1a">${title}</p>
            </div>

            <table style="width:100%;border-collapse:collapse;margin:0 0 16px;background:#f8f9fa;border-radius:8px;overflow:hidden">
              <tr><td style="padding:8px 12px;font-size:13px;color:#666;width:140px"><strong>Kunde</strong></td><td style="padding:8px 12px;font-size:13px">${firma}</td></tr>
              ${ansprechperson ? `<tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>Ansprechperson</strong></td><td style="padding:8px 12px;font-size:13px">${ansprechperson}</td></tr>` : ""}
              ${email ? `<tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>E-Mail</strong></td><td style="padding:8px 12px;font-size:13px">${email}</td></tr>` : ""}
              ${telefon ? `<tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>Telefon</strong></td><td style="padding:8px 12px;font-size:13px">${telefon}</td></tr>` : ""}
              <tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>Datum</strong></td><td style="padding:8px 12px;font-size:13px">${dateStr}${endStr && endStr !== dateStr ? ` – ${endStr}` : ""}</td></tr>
              ${creatorName ? `<tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>Erstellt von</strong></td><td style="padding:8px 12px;font-size:13px">${creatorName}</td></tr>` : ""}
            </table>

            <div style="text-align:center;margin:20px 0">
              <a href="${appUrl(`/auftraege/${jobId}`)}" style="display:inline-block;background:#1a1a1a;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
                Auftrag öffnen & Schichtplan machen
              </a>
            </div>

            <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
            <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
          </div>
        </div>
      `,
    });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message || "E-Mail fehlgeschlagen" });
  }
}
