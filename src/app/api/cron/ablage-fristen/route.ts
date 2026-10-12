// GET /api/cron/ablage-fristen
//
// Taeglicher Fristen-Waechter der NAS-Ablage (Leo 2026-10-02):
// Dokumente mit Frist (Kuendigungstermin, Vertragsablauf, Policen-Ende)
// loesen 30, 7 und 0 Tage vorher EINE Sammel-Mail an alle aktiven Admins
// aus. Quelle seit E3.4 (docs/lokale-ki/MASTERPLAN.md): ablage_fristen,
// nur Status «aktiv» — beim Ablegen erfasste und von einem Admin
// bestaetigte KI-Fristen; Vorschlaege, verworfene und erledigte nie.
// Welche Stufe schon erinnert wurde, steht in ablage_fristen.erinnert
// (jsonb-Liste) — nichts feuert doppelt.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMailBatch, mailRahmen, isMailConfigured } from "@/lib/mail";
import { logError } from "@/lib/log";
import { todayLocalIso, plusTage } from "@/lib/swiss-time";
import { faelligeErinnerungen, type FristFuerErinnerung } from "@/lib/ki/fristen-erinnerung";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
    const heute = todayLocalIso();
    // Zurich-heute + 31 Tage (datum ist eine date-Spalte).
    const horizont = plusTage(heute, 31);
    const { data: fristen, error } = await admin
      .from("ablage_fristen")
      .select("id, pfad, bezeichnung, datum, erinnert")
      .eq("status", "aktiv")
      .lte("datum", horizont)
      .gte("datum", heute) // ueberschrittene Fristen nicht ewig nachfeuern
      .order("datum")
      .limit(500);
    if (error) throw new Error(error.message);

    const faellig = faelligeErinnerungen((fristen ?? []) as FristFuerErinnerung[], heute);
    if (faellig.length === 0) {
      return NextResponse.json({ success: true, erinnert: 0 });
    }
    if (!isMailConfigured()) {
      logError("cron.ablage-fristen.mail-nicht-konfiguriert", null, { anzahl: faellig.length });
      return NextResponse.json({ success: false, error: "Mail nicht konfiguriert" }, { status: 500 });
    }

    const { data: admins } = await admin
      .from("profiles")
      .select("email")
      .eq("role", "admin")
      .eq("is_active", true)
      .not("email", "is", null);
    const empfaenger = (admins ?? []).map((a) => a.email as string).filter(Boolean);
    if (empfaenger.length === 0) {
      return NextResponse.json({ success: false, error: "Keine Admin-Empfänger gefunden" }, { status: 500 });
    }

    const fmt = (iso: string) => new Date(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });
    const zeilen = faellig
      .map((f) => {
        const label = f.stufe === 0 ? "HEUTE fällig" : `in ${f.tageBis} Tagen`;
        return `<li style="margin:0 0 8px"><strong>${esc(f.name)}</strong><br/><span style="color:#666;font-size:13px">${esc(f.ordner)} · Frist ${fmt(f.datum)} — ${label}</span></li>`;
      })
      .join("");

    const company = await loadCompanySettings(admin);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://eventline-fsm-usyk.vercel.app";
    await sendMailBatch(
      empfaenger.map((to) => ({
        to,
        subject: `⏰ EVENTLINE Fristen: ${faellig.length} Dokument${faellig.length === 1 ? "" : "e"} werden fällig`,
        html: mailRahmen({
          titel: company.name,
          inhaltHtml: `
            <p style="margin:0 0 12px">Hallo,</p>
            <p style="margin:0 0 16px">bei ${faellig.length === 1 ? "einem abgelegten Dokument" : `${faellig.length} abgelegten Dokumenten`} rückt die erfasste Frist näher:</p>
            <ul style="margin:0 0 16px;padding-left:18px">${zeilen}</ul>
            <p style="margin:0 0 12px">Alle Fristen findest du in der App unter <a href="${appUrl}/nas?tab=ablage&amp;gruppe=fristen">NAS → Ablage → Fristen</a>.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
            <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
          `,
        }),
      })),
    );

    for (const f of faellig) {
      const { error: updErr } = await admin
        .from("ablage_fristen")
        .update({ erinnert: f.erinnert, updated_at: new Date().toISOString() })
        .eq("id", f.id);
      if (updErr) logError("cron.ablage-fristen.erinnert", updErr);
    }
    return NextResponse.json({ success: true, erinnert: faellig.length, empfaenger: empfaenger.length });
  } catch (e) {
    logError("cron.ablage-fristen", e);
    return NextResponse.json({ success: false, error: "Fristen-Check fehlgeschlagen" }, { status: 500 });
  }
}
