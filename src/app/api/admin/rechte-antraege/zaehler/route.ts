// GET /api/admin/rechte-antraege/zaehler — { anzahl }: offene Rechte- und
// Lohndaten-Anträge, die der angemeldete Admin jetzt bestätigen kann (Zähler
// am Reiter «Rechte & Lohndaten» auf /antraege). Regeln:
// src/lib/lohn/antraege-zaehler.ts. Bereich «Rechte» in Wartung → 503 wie
// die übrigen Rechte-Routen.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { zaehleBestaetigbareAntraege } from "@/lib/lohn/antraege-zaehler";

export async function GET() {
  const auth = await requireAdmin({ wartung: "rechte" });
  if (auth.error) return auth.error;
  try {
    const anzahl = await zaehleBestaetigbareAntraege(createAdminClient(), {
      ich: auth.user.id,
      ansichtAls: auth.isImpersonating,
    });
    return NextResponse.json({ success: true, anzahl }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
