/**
 * Krank-Tagesabschluss — Vercel Cron «5 22,23 * * *» (UTC) = 00:05 Zuerich
 * im Sommer bzw. im Winter; der jeweils andere Lauf (23:05/01:05 Zuerich)
 * ist dank Idempotenz harmlos. Logik: krankTagesabschluss (lib/krank-server):
 *   - offene Krankmeldungen (ende_offen): end_date = heute
 *   - Arztzeugnis faellig und keins da: Person einmal erinnern
 *
 * Authorization wie andere Crons: Bearer CRON_SECRET.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { todayLocalIso } from "@/lib/swiss-time";
import { krankTagesabschluss } from "@/lib/krank-server";
import { notifyArztzeugnisErinnerung } from "@/lib/notification-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  try {
    const ergebnis = await krankTagesabschluss(admin, todayLocalIso(), (z) =>
      notifyArztzeugnisErinnerung(admin, { recipients: [z.user_id], timeOffId: z.id, ab: z.start_date }),
    );
    return NextResponse.json({ ok: true, ...ergebnis });
  } catch (e) {
    logError("cron.krank-tagesabschluss", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
