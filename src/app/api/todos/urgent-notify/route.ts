import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { appUrl } from "@/lib/app-url";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMail, mailRahmen, isMailConfigured } from "@/lib/mail";

export async function POST(request: Request) {
  // Audit-Fix g1: vorher nur requireUser() — jeder eingeloggte User konnte
  // beliebige Kollegen mit "Dringend"-Mails via unsere Domain spammen.
  // Jetzt todos:create-Gate (nur wer Todos zuweisen darf).
  const auth = await requirePermission("todos:create");
  if (auth.error) return auth.error;
  const { assignedTo, title, description, dueDate, creatorName } = await request.json();

  // Basic-Validation gegen Missbrauch: assignedTo muss ein bekannter, aktiver
  // Mitarbeiter sein — sonst kann man ueber die Route beliebige Fremd-Adressen
  // (fruehere Ex-Mitarbeiter, ausgeschiedene Profile) anschreiben.
  if (typeof assignedTo !== "string" || !/^[0-9a-f-]{36}$/i.test(assignedTo)) {
    return NextResponse.json({ success: false, error: "Ungültiger Empfänger" }, { status: 400 });
  }

  if (!isMailConfigured()) return NextResponse.json({ success: false, error: "Kein RESEND_API_KEY" });

  const supabase = createAdminClient();

  // E-Mail des zugewiesenen Users holen — nur aktive Profile.
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, full_name, is_active")
    .eq("id", assignedTo)
    .single();

  if (!profile?.email || profile.is_active === false) {
    return NextResponse.json({ success: false, error: "Keine E-Mail gefunden" });
  }

  const company = await loadCompanySettings(supabase);

  const dueDateStr = (() => {
    if (!dueDate) return null;
    // timeZone Europe/Zurich zwingend — dueDate kann timestamptz sein.
    return new Date(dueDate).toLocaleDateString("de-CH", {
      timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  })();

  const res = await sendMail({
    to: profile.email,
    subject: `Dringendes Todo: ${title}`,
    html: mailRahmen({
      titel: "Dringendes Todo",
      headerBg: "#dc2626",
      inhaltHtml: `
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
      `,
    }),
  });

  if (res.ok) return NextResponse.json({ success: true });
  return NextResponse.json({ success: false, error: "E-Mail fehlgeschlagen" });
}
