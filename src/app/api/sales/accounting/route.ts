import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCompanySettings, formatMailFooter, formatMailFrom } from "@/lib/company-settings";

export const maxDuration = 30;

export async function POST(request: Request) {
  // Auth-Gate: nur User mit vertrieb:edit duerfen Buchhaltungs-Mails ausloesen.
  // Vorher war die Route komplett offen — anonymer Phishing-Vektor an
  // buchhaltung@eventline-basel.com mit attacker-controlled Inhalt + Anhang.
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  const { type, contact, message, senderName, pdfBase64, pdfName } = await request.json();
  // type: "benachrichtigung" | "verbesserung" | "offerte_bestaetigt"

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ success: false, error: "Kein RESEND_API_KEY" });

  const resend = new Resend(resendKey);
  const company = await loadCompanySettings(createAdminClient());

  let subject = "";
  let headerText = "";
  let headerBg = "#1a1a1a";

  if (type === "benachrichtigung") {
    subject = `Vertrieb: ${contact.firma} — Verrechnungs-Benachrichtigung`;
    headerText = "Neue Vertriebs-Benachrichtigung";
    headerBg = "#3b82f6";
  } else if (type === "verbesserung") {
    subject = `Vertrieb: ${contact.firma} — Verbesserungs-Vorschlag Offerte`;
    headerText = "Verbesserungs-Vorschlag zur Offerte";
    headerBg = "#f97316";
  } else if (type === "offerte_bestaetigt") {
    subject = `Vertrieb: ${contact.firma} — Offerte bestätigt`;
    headerText = "Offerte bestätigt";
    headerBg = "#16a34a";
  }

  let detailsHtml = "";
  if (type === "benachrichtigung") {
    const details = contact.details || {};
    const rows: string[] = [];
    if (contact.ansprechperson) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>Ansprechperson</strong></td><td style="padding:6px 10px;font-size:12px">${contact.ansprechperson}${contact.position ? ` (${contact.position})` : ""}</td></tr>`);
    if (contact.email) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>E-Mail</strong></td><td style="padding:6px 10px;font-size:12px">${contact.email}</td></tr>`);
    if (contact.telefon) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>Telefon</strong></td><td style="padding:6px 10px;font-size:12px">${contact.telefon}</td></tr>`);
    if (contact.event_typ) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>Event-Typ</strong></td><td style="padding:6px 10px;font-size:12px">${contact.event_typ}</td></tr>`);
    if (details.ort) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>Ort</strong></td><td style="padding:6px 10px;font-size:12px">${details.ort}</td></tr>`);
    if (details.infrastruktur) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>Infrastruktur</strong></td><td style="padding:6px 10px;font-size:12px">${details.infrastruktur}</td></tr>`);
    if (details.zielgruppe) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>Zielgruppe</strong></td><td style="padding:6px 10px;font-size:12px">${details.zielgruppe}</td></tr>`);
    if (details.programm) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>Programm</strong></td><td style="padding:6px 10px;font-size:12px">${details.programm}</td></tr>`);
    if (details.bedarf_vor_ort) rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>Bedarf vor Ort</strong></td><td style="padding:6px 10px;font-size:12px">${details.bedarf_vor_ort}</td></tr>`);
    if (details.bedarf) {
      const BEDARF_LABELS: Record<string, string> = {
        verwaltungsaufwand: "Verwaltungsaufwand", material: "Material", arbeiten: "Arbeiten",
        stunden: "Stunden", catering: "Catering", transport: "Transport", raum: "Raum",
      };
      Object.entries(details.bedarf).forEach(([k, v]: any) => {
        rows.push(`<tr><td style="padding:6px 10px;color:#666;font-size:12px"><strong>${BEDARF_LABELS[k] || k}</strong></td><td style="padding:6px 10px;font-size:12px">${v}</td></tr>`);
      });
    }
    detailsHtml = rows.length > 0 ? `<table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f8f9fa;border-radius:8px;overflow:hidden">${rows.join("")}</table>` : "";
  }

  const html = `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:${headerBg};padding:20px 24px;border-radius:12px 12px 0 0">
        <h2 style="color:white;margin:0;font-size:16px">${company.name} · ${headerText}</h2>
      </div>
      <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
        <p style="margin:0 0 12px">Hallo Buchhaltung,</p>
        <div style="background:#f8f9fa;padding:16px;border-radius:8px;border-left:4px solid ${headerBg};margin:0 0 16px">
          <p style="margin:0 0 4px;font-weight:700;font-size:16px;color:#1a1a1a">${contact.firma}</p>
          ${contact.branche ? `<p style="margin:0;color:#666;font-size:13px">${contact.branche}</p>` : ""}
        </div>
        ${detailsHtml}
        ${message ? `<div style="background:#fef9e7;padding:14px;border-radius:8px;border-left:4px solid #f59e0b;margin:16px 0">
          <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#92400e;text-transform:uppercase">Nachricht von ${senderName || "Vertrieb"}</p>
          <p style="margin:0;color:#555;font-size:14px;white-space:pre-wrap;line-height:1.5">${message}</p>
        </div>` : ""}
        ${pdfBase64 ? `<p style="margin:16px 0 0;color:#555;font-size:13px">Die Offerte ist als PDF im Anhang.</p>` : ""}
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
      </div>
    </div>
  `;

  try {
    const attachments: any[] = [];
    if (pdfBase64) {
      attachments.push({ filename: pdfName || "offerte.pdf", content: Buffer.from(pdfBase64, "base64") });
    }

    await resend.emails.send({
      from: formatMailFrom(company, "leo@eventline-basel.com"),
      to: "buchhaltung@eventline-basel.com",
      replyTo: "leo@eventline-basel.com",
      subject,
      html,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message || "E-Mail fehlgeschlagen" });
  }
}
