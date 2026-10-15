import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { appUrl } from "@/lib/app-url";
import { ADMIN_NOTIFICATION_EMAIL } from "@/lib/constants";
import { notifySystem } from "@/lib/notification-service";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMail, mailRahmen, isMailConfigured, mailErrorMessage, escapeHtml } from "@/lib/mail";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  // Meldung «neuer Auftrag aus dem Vertrieb» an den Admin. Nur wer Auftraege
  // anlegen darf, kann einen neuen Auftrag melden (vorher reichte jedes
  // angemeldete Konto, auch Portal-Konten).
  const auth = await requirePermission("auftraege:create");
  if (auth.error) return auth.error;
  const { jobNumber, jobId, title, firma, ansprechperson, email, telefon, startDate, endDate, creatorName } = await request.json();

  // jobId landet im Link der Mail und der Benachrichtigung -> nur echte UUIDs.
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) {
    return NextResponse.json({ success: false, error: "Ungültige Auftrags-ID" }, { status: 400 });
  }
  const nummer = /^\d{1,9}$/.test(String(jobNumber ?? "")) ? String(jobNumber) : "";

  const supabase = createAdminClient();

  // In-App Notification an den primaeren Admin (via Service =>
  // user_notification_settings werden respektiert).
  const { data: admin } = await supabase.from("profiles").select("id").eq("email", ADMIN_NOTIFICATION_EMAIL).single();
  if (admin?.id) {
    await notifySystem(supabase, {
      recipients: [admin.id],
      title: `Neuer Auftrag aus Vertrieb: INT-${nummer}`,
      message: `${firma} — ${title}${creatorName ? ` (erstellt von ${creatorName})` : ""}`,
      link: `/auftraege/${jobId}`,
    });
  }

  if (!isMailConfigured()) return NextResponse.json({ success: true, note: "No email key" });
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

  // Alle Werte kommen vom Client -> vor dem Einsetzen ins Mail-HTML escapen.
  const e = escapeHtml;

  const res = await sendMail({
    to: ADMIN_NOTIFICATION_EMAIL,
    subject: `🎉 Neuer Auftrag aus Vertrieb: INT-${nummer} — ${firma}`,
    html: mailRahmen({
      titel: "🎉 Wir haben einen Auftrag bekommen!",
      headerBg: "#16a34a",
      inhaltHtml: `
        <p style="margin:0 0 16px">Aus dem Vertrieb wurde ein neuer Auftrag erstellt:</p>

        <div style="background:#f0fdf4;padding:16px;border-radius:8px;border-left:4px solid #16a34a;margin:0 0 16px">
          <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#16a34a;text-transform:uppercase;letter-spacing:0.5px">Auftrag-Nr.</p>
          <p style="margin:0 0 8px;font-family:monospace;font-size:15px;font-weight:700;color:#1a1a1a">INT-${e(nummer)}</p>
          <p style="margin:0;font-weight:600;font-size:16px;color:#1a1a1a">${e(title)}</p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin:0 0 16px;background:#f8f9fa;border-radius:8px;overflow:hidden">
          <tr><td style="padding:8px 12px;font-size:13px;color:#666;width:140px"><strong>Kunde</strong></td><td style="padding:8px 12px;font-size:13px">${e(firma)}</td></tr>
          ${ansprechperson ? `<tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>Ansprechperson</strong></td><td style="padding:8px 12px;font-size:13px">${e(ansprechperson)}</td></tr>` : ""}
          ${email ? `<tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>E-Mail</strong></td><td style="padding:8px 12px;font-size:13px">${e(email)}</td></tr>` : ""}
          ${telefon ? `<tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>Telefon</strong></td><td style="padding:8px 12px;font-size:13px">${e(telefon)}</td></tr>` : ""}
          <tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>Datum</strong></td><td style="padding:8px 12px;font-size:13px">${e(dateStr)}${endStr && endStr !== dateStr ? ` – ${e(endStr)}` : ""}</td></tr>
          ${creatorName ? `<tr><td style="padding:8px 12px;font-size:13px;color:#666"><strong>Erstellt von</strong></td><td style="padding:8px 12px;font-size:13px">${e(creatorName)}</td></tr>` : ""}
        </table>

        <div style="text-align:center;margin:20px 0">
          <a href="${e(appUrl(`/auftraege/${jobId}`))}" style="display:inline-block;background:#1a1a1a;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
            Auftrag öffnen & Schichtplan machen
          </a>
        </div>

        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
      `,
    }),
  });
  if (res.ok) return NextResponse.json({ success: true });
  return NextResponse.json({ success: false, error: mailErrorMessage(res.error) || "E-Mail fehlgeschlagen" });
}
