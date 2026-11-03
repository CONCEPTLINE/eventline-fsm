// GET /api/anfragen?stand=offen|erledigt — Seite «Meine Anfragen».
//
// Antwort: { anfragen: Anfrage[] (lib/anfragen.ts), offen: number }
// Nur eigene Meldungen (Tickets + Abwesenheiten). «Ansicht als»: die der
// angesehenen Person (nur lesen).

import { NextRequest, NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ladeAnfragen, zaehleOffeneAnfragen } from "@/lib/anfragen";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const stand = new URL(req.url).searchParams.get("stand") === "erledigt" ? "erledigt" : "offen";
  const admin = createAdminClient();
  try {
    const [anfragen, offen] = await Promise.all([
      ladeAnfragen(admin, auth.effectiveUserId, { stand, limit: stand === "erledigt" ? 100 : 200 }),
      zaehleOffeneAnfragen(admin, auth.effectiveUserId),
    ]);
    return NextResponse.json({ success: true, anfragen, offen }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    logError("api.anfragen", e, { userId: auth.effectiveUserId });
    return NextResponse.json({ success: false, error: "Anfragen konnten nicht geladen werden" }, { status: 500 });
  }
}
