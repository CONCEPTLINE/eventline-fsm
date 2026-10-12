// GET /api/cron/technik-alarme — Vercel-Cron alle 5 Minuten
// (docs/technik-dashboard/VERTRAG.md §5).
//
// Bewertet die Technik-Ampeln, schreibt Stufenwechsel nach technik_zustaende
// und meldet kritische Probleme gebuendelt an alle aktiven Admins (In-App +
// Push + Mail, erst nach 10 min kritisch; ein neuer Vorfall hoechstens alle 6 h,
// ein andauerndes Problem als Erinnerung hoechstens 1× pro 24 h).
// Entwarnung ohne Mail. In der ersten Ausfuehrung jeder Stunde verdichtet er
// zusaetzlich die Minutenwerte (technik_verdichten), damit «7 Tage» aktuell
// bleibt; der taegliche db-retention-Cron tut dasselbe als Rueckfallebene.
//
// Absicherung wie nas-backup-check: CRON_SECRET fehlt → 503, falscher Bearer → 401.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { alarmLauf } from "@/lib/technik-dashboard/alarme";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const jetzt = new Date();

  let verdichtet: unknown = null;
  if (jetzt.getUTCMinutes() < 5) {
    try {
      const { data, error } = await admin.rpc("technik_verdichten");
      if (error) logError("cron.technik-alarme.verdichten", error);
      else verdichtet = data;
    } catch (e) {
      logError("cron.technik-alarme.verdichten", e);
    }
  }

  const ergebnis = await alarmLauf(admin, jetzt);
  return NextResponse.json({ ...ergebnis, verdichtet }, { status: ergebnis.success ? 200 : 500 });
}
