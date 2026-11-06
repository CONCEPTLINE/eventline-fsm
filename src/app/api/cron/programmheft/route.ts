/**
 * Programmheft-Abgleich — Vercel Cron «15 4 * * *» (UTC, ca. 05:15/06:15
 * Zuerich). Fuer jeden Standort mit Kalender (locations.partner_kalender) und
 * eingeschaltetem Automatik-Abgleich (locations.programmheft_auto) liest er
 * die Programm-Seite der Website (src/lib/programmheft.ts), legt neue Funde
 * als Programm-Termine an und aktualisiert geaenderte — nur Zeilen mit
 * quelle = 'programmheft', geloescht wird nichts; von Hand geaenderte
 * (programm_manuell) und ausgeblendete Eintraege bleiben unberuehrt. Setzt
 * programmheft_abgeglichen_am. Ein Fehler an einem Standort haelt die anderen
 * nicht auf.
 *
 * Authorization wie andere Crons: Bearer CRON_SECRET.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { istCronAufruf } from "@/lib/geheimnis";
import { fundeUebernehmen, programmheftLesen, programmheftQuelle } from "@/lib/programmheft";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt" }, { status: 503 });
  }
  if (!istCronAufruf(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("locations")
    .select("id, name")
    .eq("partner_kalender", true)
    .eq("programmheft_auto", true);
  if (error) {
    logError("cron.programmheft", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const ergebnisse: { standortId: string; neu?: number; aktualisiert?: number; fehler?: string }[] = [];
  for (const s of (data ?? []) as { id: string; name: string | null }[]) {
    const quelle = programmheftQuelle(s.name);
    if (!quelle) continue;
    try {
      const funde = await programmheftLesen(quelle);
      const r = await fundeUebernehmen(admin, s.id, null, funde);
      ergebnisse.push({ standortId: s.id, ...r });
    } catch (e) {
      logError("cron.programmheft.standort", e, { standortId: s.id });
      ergebnisse.push({ standortId: s.id, fehler: e instanceof Error ? e.message : String(e) });
    }
  }
  const ok = ergebnisse.every((x) => !x.fehler);
  return NextResponse.json({ ok, standorte: ergebnisse }, { status: ok ? 200 : 500 });
}
