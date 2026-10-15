// GET /api/cron/zugriffe-digest
//
// Wochen-Digest «Zugriffe auf Finanzen & Lohn» (Vercel-Cron Montag 06:00
// UTC = 07:00/08:00 Zuerich) an admin@eventline-basel.com — NUR
// Zaehlungen pro Person, keine Betraege, keine Dokumentnamen.
//
//   • Fenster: letzte 7 Tage bis jetzt.
//   • Idempotenz: finanzen.digest_versand mit sent_at > now − 6 d vorhanden
//     → skipped "bereits_versendet" (Cron-Wiederholung).
//   • Zaehlung SERVER-SEITIG via finanzen.zugriffe_zaehlung(p_von, p_bis):
//     PostgREST max_rows = 1000 wuerde eine JS-Gruppierung still
//     unterzaehlen (ein Seitenaufruf erzeugt sechs Zeilen; CLAUDE.md §4).
//   • Auch bei null Zugriffen senden (Wochenrhythmus sichtbar, Annahme G.9).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMail, mailRahmen, isMailConfigured } from "@/lib/mail";
import { logError } from "@/lib/log";
import { appUrl } from "@/lib/app-url";
import { formatDateFull } from "@/lib/format";
import { finanzenDb } from "@/lib/finanzen/db";
import { ZUGRIFFE_DIGEST_EMPFAENGER, type ZugriffeZaehlungRow } from "@/lib/finanzen/types";

export const dynamic = "force-dynamic";

const FENSTER_TAGE = 7;
const SPERRE_TAGE = 6;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const bis = new Date();
    const von = new Date(bis.getTime() - FENSTER_TAGE * 86_400_000);
    const db = finanzenDb();

    // Idempotenz bei Cron-Wiederholung.
    const sperreAb = new Date(bis.getTime() - SPERRE_TAGE * 86_400_000).toISOString();
    const { data: schonVersendet, error: sperreErr } = await db
      .from("digest_versand")
      .select("id")
      .gt("sent_at", sperreAb)
      .limit(1);
    if (sperreErr) {
      logError("cron.zugriffe-digest.sperre", null, { code: sperreErr.code });
      return NextResponse.json({ success: false, error: "Versand-Nachweis nicht lesbar" }, { status: 500 });
    }
    if (schonVersendet && schonVersendet.length > 0) {
      return NextResponse.json({ success: true, versendet: false, anzahl: 0, skipped: "bereits_versendet" });
    }

    // Zaehlung server-seitig.
    const { data, error } = await db.rpc("zugriffe_zaehlung", { p_von: von.toISOString(), p_bis: bis.toISOString() });
    if (error) {
      logError("cron.zugriffe-digest.zaehlung", null, { code: error.code });
      return NextResponse.json({ success: false, error: "Zählung fehlgeschlagen" }, { status: 500 });
    }
    const zeilen = (data ?? []) as ZugriffeZaehlungRow[];
    const anzahl = zeilen.reduce((s, z) => s + Number(z.finanzen ?? 0) + Number(z.lohn ?? 0), 0);

    if (!isMailConfigured()) {
      logError("cron.zugriffe-digest.mail-nicht-konfiguriert", null, { anzahl });
      return NextResponse.json({ success: false, error: "Mail nicht konfiguriert", anzahl }, { status: 500 });
    }

    const admin = createAdminClient();
    const company = await loadCompanySettings(admin);
    const bisText = formatDateFull(bis.toISOString());

    const tabelle = zeilen.length === 0
      ? `<p style="margin:0 0 16px">Keine Zugriffe in dieser Woche.</p>`
      : `
        <table style="border-collapse:collapse;margin:16px 0;font-size:13px;color:#444;width:100%">
          <thead>
            <tr style="color:#888;text-align:left">
              <th style="padding:4px 8px 4px 0;font-weight:500">Person</th>
              <th style="padding:4px 8px;font-weight:500;text-align:right">Finanzen</th>
              <th style="padding:4px 8px;font-weight:500;text-align:right">Lohn</th>
              <th style="padding:4px 8px;font-weight:500;text-align:right">davon fremde Person</th>
              <th style="padding:4px 8px;font-weight:500;text-align:right">Freigaben</th>
              <th style="padding:4px 0 4px 8px;font-weight:500;text-align:right">Fehlversuche</th>
            </tr>
          </thead>
          <tbody>
            ${zeilen.map((z) => {
              const fehl = Number(z.fehlversuche ?? 0);
              return `<tr style="border-top:1px solid #eee">
                <td style="padding:6px 8px 6px 0">${escapeHtml(z.actor_label ?? "Unbekannt")}</td>
                <td style="padding:6px 8px;text-align:right">${Number(z.finanzen ?? 0)}</td>
                <td style="padding:6px 8px;text-align:right">${Number(z.lohn ?? 0)}</td>
                <td style="padding:6px 8px;text-align:right">${Number(z.fremde ?? 0)}</td>
                <td style="padding:6px 8px;text-align:right">${Number(z.freigaben ?? 0)}</td>
                <td style="padding:6px 0 6px 8px;text-align:right">${fehl > 0 ? `<strong>${fehl}</strong>` : fehl}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>`;

    const mailRes = await sendMail({
      from: "EVENTLINE <noreply@eventline-basel.com>",
      to: ZUGRIFFE_DIGEST_EMPFAENGER,
      subject: `[EVENTLINE] Zugriffe auf Finanzen & Lohn — Woche bis ${bisText}`,
      html: mailRahmen({
        titel: "Zugriffe auf Finanzen & Lohn",
        inhaltHtml: `
          <p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#444">
            Wer hat in den letzten 7 Tagen (bis ${bisText}) Finanzzahlen oder Lohndaten angesehen.
          </p>
          ${tabelle}
          <p style="margin:0 0 12px;font-size:13px">
            Details in der App: <a href="${appUrl("/einstellungen?tab=sicherheit")}">Einstellungen › Sicherheit</a>
          </p>
          <p style="margin:0 0 4px;color:#999;font-size:12px">Nur Zählungen — keine Beträge, keine Dokumentnamen.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
          <p style="margin:0;color:#bbb;font-size:11px">${escapeHtml(formatMailFooter(company))}</p>
        `,
      }),
    });
    if (!mailRes.ok) {
      logError("cron.zugriffe-digest.mail", mailRes.error);
      return NextResponse.json({ success: false, error: "Mail-Versand fehlgeschlagen" }, { status: 502 });
    }

    const { error: nachweisErr } = await db
      .from("digest_versand")
      .insert({ von: von.toISOString(), bis: bis.toISOString(), anzahl });
    if (nachweisErr) {
      // Mail ist raus — Nachweis fehlt. Loggen, damit ein Doppelversand bei
      // Cron-Wiederholung erklaerbar ist.
      logError("cron.zugriffe-digest.nachweis", null, { code: nachweisErr.code });
    }

    return NextResponse.json({ success: true, versendet: true, anzahl });
  } catch (e) {
    logError("cron.zugriffe-digest", e);
    return NextResponse.json({ success: false, error: "Digest fehlgeschlagen" }, { status: 500 });
  }
}

// HTML-Escape (Muster trust/devices) — Resend rendert das HTML rein.
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
