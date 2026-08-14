import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { requirePermission } from "@/lib/api-auth";
import { loadCompanySettings, formatMailFooter, formatMailFrom } from "@/lib/company-settings";

export const maxDuration = 60;

// Vereinheitlichter Mail-Versand fuer die Vermietentwurf-Pipeline.
// step bestimmt Template:
//   1 = Mietkonditionen (mit Confirm-Link, type=konditionen)
//   3 = Angebot          (mit Confirm-Link, type=angebot)
// Schritt 5 (Vertrag senden) gibt es nicht mehr — nach Angebot-Bestaetigung
// (Schritt 4) wird der Vermietentwurf direkt in einen Auftrag umgewandelt.
type Step = 1 | 3;

interface Body {
  jobId: string;
  step: Step;
  email: string;
  cc?: string[];
  message?: string;
  customerName?: string | null;
  locationName?: string | null;
  eventDate?: string | null;
  eventEndDate?: string | null;
  documentPaths: string[];
}

import { appUrl } from "@/lib/app-url";

// Public-facing URL fuer Customer-Confirm-Links. Muss auf einen Server
// zeigen, der die Route /api/auftraege/vermietentwurf/confirm hat (also
// redesign-Code). Auf Vercel kommt das über NEXT_PUBLIC_VERCEL_URL =
// das genau laufende Deployment, im Dev über localhost.
const APP_URL = appUrl();

function formatDate(d: string | null | undefined) {
  if (!d) return "";
  // timeZone Europe/Zurich zwingend — d kann timestamptz sein
  // ("2026-06-13T22:00:00+00:00" = 14.06 ZRH).
  return new Date(d).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

// HMAC-Token analog zur Verify-Seite — passt zum hmacToken() in
// /api/auftraege/vermietentwurf/confirm/route.ts. Wenn jemand das Secret
// nicht kennt, kann er offline keinen Token konstruieren auch wenn er die
// Job-UUID kennt. CONFIRM_SECRET ist Pflicht — kein Fallback auf
// SERVICE_ROLE_KEY mehr (wuerde Trust-Boundary verschmutzen).
function confirmToken(jobId: string, type: "konditionen" | "angebot"): string {
  const secret = process.env.CONFIRM_SECRET;
  if (!secret) {
    throw new Error("CONFIRM_SECRET fehlt in der Server-Config");
  }
  return createHmac("sha256", secret).update(`${jobId}:${type}`).digest("hex");
}

export async function POST(request: Request) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const body = (await request.json()) as Body;
  const { jobId, step, email, cc, message, customerName, locationName, eventDate, eventEndDate, documentPaths } = body;

  if (![1, 3].includes(step)) {
    return NextResponse.json({ success: false, error: "Ungueltiger Schritt" }, { status: 400 });
  }
  if (!email) return NextResponse.json({ success: false, error: "Empfaenger fehlt" }, { status: 400 });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ success: false, error: "Kein RESEND_API_KEY" });

  const supabase = createAdminClient();
  const company = await loadCompanySettings(supabase);

  // Anhaenge aus Storage laden
  const attachments: { filename: string; content: Buffer }[] = [];
  for (const path of documentPaths) {
    const { data, error } = await supabase.storage.from("documents").download(path);
    if (error || !data) {
      return NextResponse.json({ success: false, error: `Datei nicht gefunden: ${path}` }, { status: 500 });
    }
    const filename = path.split("/").pop() ?? "dokument.pdf";
    attachments.push({ filename, content: Buffer.from(await data.arrayBuffer()) });
  }

  const dateStr = formatDate(eventDate);
  const endDateStr = formatDate(eventEndDate);
  const loc = locationName || "Location";
  const greeting = `Guten Tag${customerName ? " " + customerName : ""},`;
  const eventBlock = `
    <div style="background:#f8f9fa;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;margin:0 0 16px">
      <p style="margin:0 0 4px;font-weight:600;font-size:16px;color:#1a1a1a">${loc}</p>
      <p style="margin:0;color:#666">${dateStr}${endDateStr ? ` &ndash; ${endDateStr}` : ""}</p>
    </div>`;

  const messageBlock = message
    ? `<p style="margin:0 0 16px;color:#555;font-size:14px;white-space:pre-wrap">${message.replace(/</g, "&lt;")}</p>`
    : "";

  let subject: string;
  let intro: string;
  let cta = "";

  if (step === 1) {
    subject = `Mietkonditionen: ${loc}${dateStr ? ` – ${dateStr}` : ""}`;
    intro = "Vielen Dank f&uuml;r Ihre Anfrage. Anbei finden Sie unsere Mietkonditionen:";
    const url = `${APP_URL}/api/auftraege/vermietentwurf/confirm?id=${jobId}&token=${confirmToken(jobId, "konditionen")}&type=konditionen`;
    cta = `
      <div style="text-align:center;margin:24px 0">
        <a href="${url}" style="display:inline-block;background:#16a34a;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
          Konditionen best&auml;tigen
        </a>
      </div>
      <p style="margin:0 0 8px;color:#999;font-size:12px;text-align:center">Mit Klick auf den Button best&auml;tigen Sie die Konditionen.</p>`;
  } else {
    // step === 3 (Angebot) — die einzige andere Variante; Step 5 gibt es nicht mehr.
    subject = `Angebot: ${loc}${dateStr ? ` – ${dateStr}` : ""}`;
    intro = "Vielen Dank f&uuml;r die Best&auml;tigung unserer Konditionen. Anbei erhalten Sie unser Angebot:";
    const url = `${APP_URL}/api/auftraege/vermietentwurf/confirm?id=${jobId}&token=${confirmToken(jobId, "angebot")}&type=angebot`;
    cta = `
      <div style="text-align:center;margin:24px 0">
        <a href="${url}" style="display:inline-block;background:#16a34a;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
          Angebot verbindlich annehmen
        </a>
      </div>
      <p style="margin:0 0 8px;color:#999;font-size:12px;text-align:center">Mit Klick auf den Button nehmen Sie das Angebot verbindlich an.</p>`;
  }

  // Logo inline als data URL. logo-mail.png ist auf exakt Display-Aspekt
  // pre-resized (260x60 = 2x retina fuer 130x30) — Outlook clippte das
  // Original (800x185) weil es nicht sauber herunterskalierte.
  let logoSrc = "";
  try {
    const logoBuf = readFileSync(join(process.cwd(), "public", "logo-mail.png"));
    logoSrc = `data:image/png;base64,${logoBuf.toString("base64")}`;
  } catch {
    logoSrc = `${APP_URL}/logo-mail.png`;
  }

  const html = `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
        <img src="${logoSrc}" alt="EVENTLINE GmbH" width="130" height="30" style="display:block;border:0;outline:none;text-decoration:none">
      </div>
      <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
        <p style="margin:0 0 12px">${greeting}</p>
        <p style="margin:0 0 16px">${intro}</p>
        ${eventBlock}
        ${messageBlock}
        ${cta}
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0"/>
        <p style="margin:0;color:#999;font-size:13px">Bei Fragen erreichen Sie uns unter <a href="mailto:leo@eventline-basel.com" style="color:#3b82f6">leo@eventline-basel.com</a></p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
        <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
      </div>
    </div>`;

  try {
    const resend = new Resend(resendKey);
    const ccList = (cc ?? []).map((s) => s.trim()).filter(Boolean);
    await resend.emails.send({
      from: formatMailFrom(company, "leo@eventline-basel.com"),
      replyTo: "leo@eventline-basel.com",
      to: email,
      cc: ccList.length > 0 ? ccList : undefined,
      subject,
      html,
      attachments,
    });
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "E-Mail fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
