import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requireUser } from "@/lib/api-auth";
import { appUrl } from "@/lib/app-url";
import { loadCompanySettings, formatMailFooter, formatMailFrom } from "@/lib/company-settings";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { assignedTo, title, description, dueDate, creatorName } = await request.json();

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ success: false, error: "Kein RESEND_API_KEY" });

  const supabase = createAdminClient();

  // E-Mail des zugewiesenen Users holen
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, full_name")
    .eq("id", assignedTo)
    .single();

  if (!profile?.email) return NextResponse.json({ success: false, error: "Keine E-Mail gefunden" });

  const resend = new Resend(resendKey);

  const company = await loadCompanySettings(supabase);

  const dueDateStr = (() => {
    if (!dueDate) return null;
    // timeZone Europe/Zurich zwingend — dueDate kann timestamptz sein.
    return new Date(dueDate).toLocaleDateString("de-CH", {
      timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  })();

  try {
    await resend.emails.send({
      from: formatMailFrom(company, "noreply@eventline-basel.com"),
      to: profile.email,
      subject: `Dringendes Todo: ${title}`,
      html: `
        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#dc2626;padding:20px 24px;border-radius:12px 12px 0 0">
            <h2 style="color:white;margin:0;font-size:16px">Dringendes Todo</h2>
          </div>
          <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
            <p style="margin:0 0 12px">Hallo ${profile.full_name},</p>
            <p style="margin:0 0 16px">Du hast ein <strong>dringendes Todo</strong> erhalten:</p>

            <div style="background:#fef2f2;padding:16px;border-radius:8px;border-left:4px solid #dc2626;margin:0 0 16px">
              <p style="margin:0 0 4px;font-weight:700;font-size:16px;color:#1a1a1a">${title}</p>
              ${description ? `<p style="margin:4px 0 0;color:#555;font-size:14px">${description}</p>` : ""}
              ${dueDateStr ? `<p style="margin:8px 0 0;color:#dc2626;font-size:13px;font-weight:600">Fällig: ${dueDateStr}</p>` : ""}
            </div>

            <p style="margin:0 0 16px;color:#666;font-size:14px">Erstellt von: <strong>${creatorName}</strong></p>

            <div style="text-align:center;margin:24px 0">
              <a href="${appUrl("/todos")}" style="display:inline-block;background:#dc2626;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
                Todo öffnen
              </a>
            </div>

            <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
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
