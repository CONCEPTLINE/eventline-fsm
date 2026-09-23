import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMail, mailRahmen, isMailConfigured, mailErrorMessage } from "@/lib/mail";

export async function POST(request: Request) {
  // Audit-Fix g1: vorher nur requireUser() — jeder eingeloggte User konnte
  // an beliebige profile_id Schicht-Mails schicken (Phishing-Vector via
  // client-kontrolliertem Titel/Datum/Zeit). Jetzt kalender:create-Gate.
  const auth = await requirePermission("kalender:create");
  if (auth.error) return auth.error;
  const body = await request.json();
  const { profile_id, shift_title, shift_date, start_time, end_time } = body;

  if (!profile_id || typeof profile_id !== "string" || !/^[0-9a-f-]{36}$/i.test(profile_id)) {
    return NextResponse.json({ error: "Kein/ungültiger Mitarbeiter angegeben" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const company = await loadCompanySettings(supabase);

  // Mitarbeiter-Profil laden — nur aktive.
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email, is_active")
    .eq("id", profile_id)
    .single();

  if (!profile || !profile.email || profile.is_active === false) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden" }, { status: 404 });
  }

  const formattedDate = new Date(shift_date + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  if (!isMailConfigured()) {
    return NextResponse.json({ success: false, emailSent: false, reason: "Kein RESEND_API_KEY" });
  }

  const res = await sendMail({
    to: profile.email,
    subject: `Schicht zugeteilt: ${shift_title} am ${formattedDate}`,
    html: mailRahmen({
      titel: company.name,
      inhaltHtml: `
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
      `,
    }),
  });

  if (res.ok) return NextResponse.json({ success: true, emailSent: true });
  return NextResponse.json({ success: false, emailSent: false, error: mailErrorMessage(res.error) ?? "Unbekannter Fehler" });
}
