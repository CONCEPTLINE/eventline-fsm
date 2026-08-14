import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requireUser } from "@/lib/api-auth";
import { loadCompanySettings, formatMailFooter, formatMailFrom } from "@/lib/company-settings";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const body = await request.json();
  const { profile_id, shift_title, shift_date, start_time, end_time } = body;

  if (!profile_id) {
    return NextResponse.json({ error: "Kein Mitarbeiter angegeben" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const company = await loadCompanySettings(supabase);

  // Mitarbeiter-Profil laden
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email")
    .eq("id", profile_id)
    .single();

  if (!profile || !profile.email) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden" }, { status: 404 });
  }

  const formattedDate = new Date(shift_date + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json({ success: false, emailSent: false, reason: "Kein RESEND_API_KEY" });
  }

  try {
    const resend = new Resend(resendKey);
    await resend.emails.send({
      from: formatMailFrom(company, "noreply@eventline-basel.com"),
      to: profile.email,
      subject: `Schicht zugeteilt: ${shift_title} am ${formattedDate}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto;">
          <div style="background: #1a1a1a; padding: 24px; border-radius: 12px 12px 0 0;">
            <h2 style="color: white; margin: 0; font-size: 18px;">${company.name}</h2>
          </div>
          <div style="background: white; padding: 24px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="margin: 0 0 16px;">Hallo ${profile.full_name},</p>
            <p style="margin: 0 0 16px;">Dir wurde eine neue Schicht zugeteilt:</p>
            <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; border-left: 4px solid #ef4444; margin: 0 0 16px;">
              <p style="margin: 0 0 4px; font-weight: 600;">${shift_title}</p>
              <p style="margin: 0 0 4px; color: #666; font-size: 14px;">${formattedDate}</p>
              <p style="margin: 0; color: #666; font-size: 14px;">${start_time} – ${end_time} Uhr</p>
            </div>
            <p style="margin: 0 0 8px; color: #999; font-size: 13px;">
              Bei Fragen melde dich bei der Einsatzleitung.
            </p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;" />
            <p style="margin: 0; color: #bbb; font-size: 11px;">
              ${formatMailFooter(company)}
            </p>
          </div>
        </div>
      `,
    });

    return NextResponse.json({ success: true, emailSent: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, emailSent: false, error: err.message });
  }
}
