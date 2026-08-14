import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requireUser } from "@/lib/api-auth";
import { loadCompanySettings, formatMailFooter, formatMailFrom } from "@/lib/company-settings";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { title, description, due_date, assigned_to } = await request.json();

  if (!assigned_to || !title) {
    return NextResponse.json({ success: false });
  }

  const supabase = createAdminClient();
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ success: false, error: "Kein RESEND_API_KEY" });

  const resend = new Resend(resendKey);

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email")
    .eq("id", assigned_to)
    .single();

  if (!profile?.email) {
    return NextResponse.json({ success: false, error: "Kein Profil gefunden" });
  }

  const dateStr = due_date
    ? new Date(due_date + "T12:00:00Z").toLocaleDateString("de-CH", {
        timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
      })
    : null;

  const company = await loadCompanySettings(supabase);
  try {
    await resend.emails.send({
      from: formatMailFrom(company, "noreply@eventline-basel.com"),
      to: profile.email,
      subject: `DRINGEND: ${title}`,
      html: `
        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
            <h2 style="color:white;margin:0;font-size:16px">${company.name}</h2>
          </div>
          <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
            <p style="margin:0 0 12px">Hallo ${profile.full_name},</p>
            <p style="margin:0 0 16px">Dir wurde ein <strong style="color:#dc2626">dringendes Todo</strong> zugewiesen:</p>
            <div style="background:#fef2f2;padding:16px;border-radius:8px;border-left:4px solid #dc2626;margin:0 0 16px">
              <p style="margin:0 0 4px;font-weight:600;font-size:16px">${title}</p>
              ${description ? `<p style="margin:4px 0 0;color:#666;font-size:14px">${description}</p>` : ""}
              ${dateStr ? `<p style="margin:8px 0 0;color:#dc2626;font-size:13px;font-weight:500">Fällig: ${dateStr}</p>` : ""}
            </div>
            <p style="margin:0 0 8px;color:#999;font-size:13px">Öffne die App für weitere Details.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
            <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
          </div>
        </div>
      `,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: "E-Mail fehlgeschlagen" });
  }
}
