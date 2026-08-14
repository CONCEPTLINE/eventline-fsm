// POST /api/appointments/[id]/send-confirmation
//
// Schickt eine Termin-Bestaetigung per Email an den Kunden. Body:
//   { customer_email, customer_name?, custom_message? }
// Speichert customer_email + customer_name auf den Termin, setzt
// confirmation_sent_at = now() und sendet die HTML-Mail via Resend.
//
// Permission: User muss den Termin sehen (RLS prueft automatisch via
// User-Client). Wer den Termin sehen darf, darf auch eine Bestaetigung
// senden — Mail-Versand ist Teil der Termin-Verwaltung.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { Resend } from "resend";
import { logError } from "@/lib/log";
import { loadCompanySettings, formatMailFrom, formatFullFooter } from "@/lib/company-settings";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Body fehlt" }, { status: 400 });

  const customerEmail = String(body.customer_email ?? "").trim();
  const customerName = body.customer_name ? String(body.customer_name).trim() : null;
  const customMessage = body.custom_message ? String(body.custom_message).trim() : null;

  if (!EMAIL_RE.test(customerEmail)) {
    return NextResponse.json({ success: false, error: "Ungueltige Email-Adresse" }, { status: 400 });
  }

  // RLS-User-Client fuer den Termin-Read — wer ihn nicht sehen darf,
  // bekommt 404. Verhindert Mail-Spam-Missbrauch via fremder Termin-IDs.
  const userClient = await createClient();
  const { data: appt, error: apptErr } = await userClient
    .from("job_appointments")
    .select("id, title, description, start_time, end_time, job:jobs(title, job_number, customer:customers(name))")
    .eq("id", id)
    .single();
  if (apptErr || !appt) {
    return NextResponse.json({ success: false, error: "Termin nicht gefunden oder keine Berechtigung" }, { status: 404 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json({ success: false, error: "Mail-Versand nicht konfiguriert" }, { status: 503 });
  }
  const resend = new Resend(resendKey);

  const admin = createAdminClient();
  const company = await loadCompanySettings(admin);

  // Mail-Body bauen
  const start = new Date(appt.start_time);
  const end = appt.end_time ? new Date(appt.end_time) : null;
  const dateStr = start.toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const startTime = start.toLocaleTimeString("de-CH", {
    timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit",
  });
  const endTime = end?.toLocaleTimeString("de-CH", {
    timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit",
  });

  const greeting = customerName ? `Guten Tag ${customerName}` : "Guten Tag";
  const customSection = customMessage
    ? `<tr><td style="padding:16px 0 0 0;color:#374151;font-size:14px;line-height:1.6">${escapeHtml(customMessage).replace(/\n/g, "<br>")}</td></tr>`
    : "";

  const html = `
    <!DOCTYPE html>
    <html lang="de">
    <head><meta charset="utf-8"></head>
    <body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f7;padding:32px 16px">
        <tr><td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:540px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
            <tr><td style="background:#1a1a1a;padding:20px 24px">
              <h1 style="margin:0;color:#ffffff;font-size:18px;letter-spacing:0.02em">${company.name}</h1>
            </td></tr>
            <tr><td style="padding:24px 24px 8px 24px">
              <p style="margin:0 0 16px 0;color:#111827;font-size:15px">${escapeHtml(greeting)},</p>
              <p style="margin:0 0 16px 0;color:#111827;font-size:15px">wir bestätigen Ihnen den folgenden Termin:</p>
            </td></tr>
            <tr><td style="padding:0 24px">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f9fafb;border-radius:8px;border-left:4px solid #ef4444">
                <tr><td style="padding:16px 18px">
                  <p style="margin:0 0 6px 0;color:#111827;font-size:16px;font-weight:600">${escapeHtml(appt.title)}</p>
                  <p style="margin:0 0 6px 0;color:#374151;font-size:14px">
                    <strong>${escapeHtml(dateStr)}</strong><br>
                    ${escapeHtml(startTime)}${endTime ? ` – ${escapeHtml(endTime)}` : ""} Uhr
                  </p>
                  ${appt.description ? `<p style="margin:8px 0 0 0;color:#6b7280;font-size:13px;line-height:1.5">${escapeHtml(appt.description).replace(/\n/g, "<br>")}</p>` : ""}
                </td></tr>
              </table>
              ${customSection}
            </td></tr>
            <tr><td style="padding:20px 24px 24px 24px;color:#374151;font-size:14px;line-height:1.6">
              <p style="margin:0">Bei Fragen oder Aenderungen sind wir gerne fuer Sie da.</p>
              <p style="margin:8px 0 0 0">Freundliche Gruesse<br><strong>${company.name}</strong></p>
            </td></tr>
            <tr><td style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px;text-align:center">
              ${formatFullFooter(company)}
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  try {
    const sendRes = await resend.emails.send({
      from: formatMailFrom(company, "noreply@eventline-basel.com"),
      to: customerEmail,
      subject: `Termin-Bestaetigung: ${appt.title} am ${dateStr}`,
      html,
    });
    if (sendRes.error) {
      logError("appointments.send-confirmation.resend", sendRes.error, { apptId: id });
      return NextResponse.json({ success: false, error: sendRes.error.message ?? "Versand fehlgeschlagen" }, { status: 502 });
    }
  } catch (e) {
    logError("appointments.send-confirmation.exception", e, { apptId: id });
    return NextResponse.json({ success: false, error: "Versand fehlgeschlagen" }, { status: 502 });
  }

  // Empfaenger + Timestamp auf dem Termin festhalten — Admin-Client weil
  // job_appointments UPDATE per RLS nicht garantiert ist und der User
  // den Termin nur dafuer ergaenzen darf, nicht generell mutieren.
  await admin
    .from("job_appointments")
    .update({
      customer_email: customerEmail,
      customer_name: customerName,
      confirmation_sent_at: new Date().toISOString(),
    })
    .eq("id", id);

  return NextResponse.json({ success: true });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
