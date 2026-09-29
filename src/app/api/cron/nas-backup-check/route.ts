// GET /api/cron/nas-backup-check
//
// Taeglicher Waechter fuers NAS-Backup (Vercel-Cron 06:00 UTC = 07:00/
// 08:00 Zurich, also nach dem 03:00-Backup-Lauf). Prueft die Meldungen
// des Backup-Containers (nas_backup_runs) und mailt ALLE aktiven Admins,
// wenn etwas faul ist — damit ein still stehendes Backup nie wieder
// monatelang unbemerkt bleibt (Leo 2026-09-29).
//
// Alarm-Kriterien:
//   - letzte OK-Meldung aelter als 26h  → "Backup ueberfaellig"
//   - neueste Meldung hat status=fehler → "Backup fehlgeschlagen"
// KEIN Alarm, solange noch NIE eine Meldung ankam (Feature frisch
// eingerichtet, NAS-Seite evtl. noch nicht aktualisiert) — dieser
// Zustand ist im Backup-Tab der NAS-Seite als Warnung sichtbar.
//
// Spam-Schutz: max. eine Alarm-Mail pro 20h (nas_backup_alerts).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMailBatch, mailRahmen, isMailConfigured } from "@/lib/mail";
import { logError } from "@/lib/log";

const STALE_STUNDEN = 26;
const ALERT_ABSTAND_STUNDEN = 20;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  try {
    const { data: runs, error } = await admin
      .from("nas_backup_runs")
      .select("run_date, status, reported_at")
      .order("reported_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);

    if (!runs || runs.length === 0) {
      return NextResponse.json({ success: true, zustand: "nie_gemeldet", alarm: false });
    }

    const letzterOk = runs.find((r) => r.status === "ok") ?? null;
    const okAlterH = letzterOk
      ? (Date.now() - new Date(letzterOk.reported_at).getTime()) / 3600_000
      : Infinity;
    const neuesteFehler = runs[0].status === "fehler";

    let grund: string | null = null;
    if (okAlterH > STALE_STUNDEN) {
      grund = letzterOk
        ? `Letzter erfolgreicher Backup-Lauf ist ${Math.floor(okAlterH)} Stunden her (${letzterOk.run_date}).`
        : "Es gibt Meldungen vom NAS, aber noch nie einen erfolgreichen Backup-Lauf.";
    } else if (neuesteFehler) {
      grund = `Der letzte Backup-Lauf (${runs[0].run_date}) wurde als FEHLGESCHLAGEN gemeldet.`;
    }

    if (!grund) {
      return NextResponse.json({ success: true, zustand: "ok", alarm: false });
    }

    // Spam-Schutz: schon kuerzlich alarmiert?
    const { data: letzterAlert } = await admin
      .from("nas_backup_alerts")
      .select("sent_at")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (letzterAlert && Date.now() - new Date(letzterAlert.sent_at).getTime() < ALERT_ABSTAND_STUNDEN * 3600_000) {
      return NextResponse.json({ success: true, zustand: "alarm_unterdrueckt", alarm: false, grund });
    }

    if (!isMailConfigured()) {
      logError("cron.nas-backup-check.mail-nicht-konfiguriert", null, { grund });
      return NextResponse.json({ success: false, error: "Mail nicht konfiguriert", grund }, { status: 500 });
    }

    const { data: admins } = await admin
      .from("profiles")
      .select("email, full_name")
      .eq("role", "admin")
      .eq("is_active", true)
      .not("email", "is", null);
    const empfaenger = (admins ?? []).map((a) => a.email as string).filter(Boolean);
    if (empfaenger.length === 0) {
      return NextResponse.json({ success: false, error: "Keine Admin-Empfänger gefunden", grund }, { status: 500 });
    }

    const company = await loadCompanySettings(admin);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://eventline-fsm-usyk.vercel.app";
    await sendMailBatch(
      empfaenger.map((to) => ({
        to,
        subject: "⚠️ EVENTLINE NAS-Backup: Problem erkannt",
        html: mailRahmen({
          titel: company.name,
          inhaltHtml: `
            <p style="margin:0 0 12px">Hallo,</p>
            <p style="margin:0 0 16px">die automatische Überwachung hat ein Problem mit dem nächtlichen NAS-Backup erkannt:</p>
            <div style="background:#fef2f2;padding:16px;border-radius:8px;border-left:4px solid #dc2626;margin:0 0 16px">
              <p style="margin:0;font-weight:600">${grund}</p>
            </div>
            <p style="margin:0 0 12px">Bitte prüfen: Docker-App auf dem UGREEN-NAS → Container <strong>eventline-backup</strong> → Log. Den aktuellen Stand zeigt auch die App unter <a href="${appUrl}/nas?tab=backup">NAS → Backup</a>.</p>
            <p style="margin:0 0 4px;color:#999;font-size:13px">Diese Warnung wird höchstens einmal pro Tag versendet, solange das Problem besteht.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
            <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
          `,
        }),
      })),
    );

    await admin.from("nas_backup_alerts").insert({ grund });
    return NextResponse.json({ success: true, zustand: "alarm_gesendet", alarm: true, empfaenger: empfaenger.length, grund });
  } catch (e) {
    logError("cron.nas-backup-check", e);
    return NextResponse.json({ success: false, error: "Check fehlgeschlagen" }, { status: 500 });
  }
}
