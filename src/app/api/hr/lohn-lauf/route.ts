// GET /api/hr/lohn-lauf — Status der letzten automatischen Lohnläufe
// (lohn_lauf), damit Fehler in der App sichtbar sind und nicht nur im
// Server-Log. Lohnrecht + vertrautes Gerät.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";

export async function GET() {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const { data, error } = await createAdminClient()
    .from("lohn_lauf")
    .select("id, gestartet_at, beendet_at, ausloeser, status, erstellt, fehler, offen, ergebnisse, hinweise, zusammenfassung")
    .order("gestartet_at", { ascending: false })
    .limit(5);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, laeufe: data ?? [] });
}
