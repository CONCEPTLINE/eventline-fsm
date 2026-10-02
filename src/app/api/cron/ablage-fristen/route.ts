// GET /api/cron/ablage-fristen
//
// Taeglicher Fristen-Waechter der NAS-Ablage (Leo 2026-10-02):
// Dokumente mit erfasster Frist (Kuendigungstermin, Vertragsablauf,
// Policen-Ende) loesen 30, 7 und 0 Tage vorher EINE Sammel-Mail an
// alle aktiven Admins aus. Welche Stufe schon erinnert wurde, steht
// in ablage_items.frist_erinnert (jsonb-Liste) — nichts feuert doppelt.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMailBatch, mailRahmen, isMailConfigured } from "@/lib/mail";
import { logError } from "@/lib/log";

const STUFEN = [30, 7, 0];

function heuteZurich(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
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
    const heute = heuteZurich();
    const horizont = new Date(Date.now() + 31 * 86400_000).toISOString().slice(0, 10);
    const { data: items, error } = await admin
      .from("ablage_items")
      .select("id, abgelegt_name, ordner_pfad, frist, frist_erinnert")
      .not("frist", "is", null)
      .lte("frist", horizont)
      .gte("frist", heute) // ueberschrittene Fristen nicht ewig nachfeuern
      .limit(500);
    if (error) throw new Error(error.message);

    const faellig: { id: string; name: string; ordner: string; frist: string; stufe: number; erinnert: number[] }[] = [];
    for (const it of items ?? []) {
      const erinnert: number[] = Array.isArray(it.frist_erinnert) ? (it.frist_erinnert as number[]) : [];
      const tageBis = Math.round((new Date(it.frist as string).getTime() - new Date(heute).getTime()) / 86400_000);
      // Die kleinste erreichte Stufe erinnern (30 -> 7 -> 0), jede nur einmal.
      const stufe = STUFEN.find((s) => tageBis <= s && !erinnert.includes(s));
      if (stufe === undefined) continue;
      faellig.push({
        id: it.id as string,
        name: it.abgelegt_name as string,
        ordner: it.ordner_pfad as string,
        frist: it.frist as string,
        stufe,
        erinnert,
      });
    }

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
        const label = f.stufe === 0 ? "HEUTE fällig" : `in ${Math.max(0, Math.round((new Date(f.frist).getTime() - new Date(heute).getTime()) / 86400_000))} Tagen`;
        return `<li style="margin:0 0 8px"><strong>${f.name}</strong><br/><span style="color:#666;font-size:13px">${f.ordner} · Frist ${fmt(f.frist)} — ${label}</span></li>`;
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
            <p style="margin:0 0 12px">Dokumente findest du in der App unter <a href="${appUrl}/nas?tab=ablage">NAS → Ablage</a> (Suche nach dem Namen).</p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
            <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
          `,
        }),
      })),
    );

    for (const f of faellig) {
      await admin
        .from("ablage_items")
        .update({ frist_erinnert: [...f.erinnert, f.stufe] })
        .eq("id", f.id);
    }
    return NextResponse.json({ success: true, erinnert: faellig.length, empfaenger: empfaenger.length });
  } catch (e) {
    logError("cron.ablage-fristen", e);
    return NextResponse.json({ success: false, error: "Fristen-Check fehlgeschlagen" }, { status: 500 });
  }
}
