// GET /api/hr/lohn-lauf[?anzahl=20] — Protokoll der automatischen Lohnläufe
// (lohn_lauf, neueste zuerst), damit Fehler in der App sichtbar sind und nicht
// nur im Server-Log. Je Lauf: Status (ok / teilweise / fehler / blockiert /
// pausiert / abgebrochen), Zähler, Ergebnisse je Person/Monat mit Grund,
// Hinweise und der Stand der Alarm-Mail (Phase 4). Lohnrecht + vertrautes Gerät.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";

export async function GET(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const roh = Number(new URL(req.url).searchParams.get("anzahl") ?? "20");
  const anzahl = Number.isInteger(roh) ? Math.min(50, Math.max(1, roh)) : 20;
  const { data, error } = await createAdminClient()
    .from("lohn_lauf")
    .select("id, gestartet_at, beendet_at, ausloeser, status, erstellt, fehler, blockiert, offen, ergebnisse, hinweise, zusammenfassung, alarm_gesendet_at, alarm_empfaenger, alarm_fehler")
    .order("gestartet_at", { ascending: false })
    .limit(anzahl);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, laeufe: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
