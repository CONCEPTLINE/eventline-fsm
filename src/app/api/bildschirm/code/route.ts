// POST /api/bildschirm/code — 6-stelligen Bestaetigungscode erzeugen und
// an admin@eventline-basel.com mailen (Buero-Bildschirm ohne Login).
// Oeffentlich erreichbar, deshalb gebremst: max. 1 Code pro Minute und
// 10 pro Stunde (gezaehlt ueber die Tabelle selbst). Der Code wird nie
// zurueckgegeben — nur per Mail.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMailConfigured, sendMail, mailRahmen } from "@/lib/mail";
import { BILDSCHIRM_MAIL, CODE_MINUTEN, hashWert, neuerCode } from "@/lib/bildschirm";
import { logError } from "@/lib/log";

export async function POST(req: NextRequest) {
  if (!isMailConfigured()) {
    return NextResponse.json({ success: false, error: "Mail-Versand ist nicht konfiguriert." }, { status: 503 });
  }
  const admin = createAdminClient();
  const now = Date.now();
  const [minute, stunde] = await Promise.all([
    admin.from("bildschirm_codes").select("id", { count: "exact", head: true }).gte("created_at", new Date(now - 60_000).toISOString()),
    admin.from("bildschirm_codes").select("id", { count: "exact", head: true }).gte("created_at", new Date(now - 3_600_000).toISOString()),
  ]);
  if ((minute.count ?? 0) >= 1) {
    return NextResponse.json({ success: false, error: "Es wurde gerade ein Code verschickt — bitte eine Minute warten." }, { status: 429 });
  }
  if ((stunde.count ?? 0) >= 10) {
    return NextResponse.json({ success: false, error: "Zu viele Anfragen — bitte später erneut versuchen." }, { status: 429 });
  }

  const code = neuerCode();
  const gueltigBis = new Date(now + CODE_MINUTEN * 60_000);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const { data: zeile, error } = await admin
    .from("bildschirm_codes")
    .insert({ code_hash: hashWert(code), expires_at: gueltigBis.toISOString(), ip })
    .select("id")
    .single();
  if (error || !zeile) {
    logError("bildschirm.code.insert", error);
    return NextResponse.json({ success: false, error: "Code konnte nicht erzeugt werden." }, { status: 500 });
  }

  const mail = await sendMail({
    to: BILDSCHIRM_MAIL,
    subject: `Bildschirm-Code ${code}`,
    html: mailRahmen({
      titel: "Büro-Bildschirm freischalten",
      inhaltHtml: `
        <p style="margin:0 0 16px;color:#333;font-size:14px">Jemand möchte den Büro-Bildschirm mit dem EVENTLINE-Dashboard verbinden. Der Bestätigungscode lautet:</p>
        <p style="margin:0 0 16px;font-family:'Courier New',monospace;font-size:36px;font-weight:700;letter-spacing:0.3em;color:#1D1D1B">${code}</p>
        <p style="margin:0;color:#666;font-size:12px">Gültig ${CODE_MINUTEN} Minuten. Wenn du das nicht angefordert hast, kannst du diese Mail ignorieren — ohne den Code passiert nichts.</p>`,
    }),
  });
  if (!mail.ok) {
    await admin.from("bildschirm_codes").delete().eq("id", zeile.id);
    logError("bildschirm.code.mail", mail.error);
    return NextResponse.json({ success: false, error: "Die Mail konnte nicht gesendet werden." }, { status: 502 });
  }
  return NextResponse.json({ success: true, gueltig_bis: gueltigBis.toISOString(), empfaenger: BILDSCHIRM_MAIL });
}
