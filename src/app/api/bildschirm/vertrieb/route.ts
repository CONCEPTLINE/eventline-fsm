// GET /api/bildschirm/vertrieb — zweite Ansicht des Buero-Bildschirms
// (Leo 2026-10-30). Zugang wie /api/bildschirm/daten nur ueber das
// Bildschirm-Cookie, rein lesend. Berechnung: src/lib/vertrieb/uebersicht.ts
// (gleich wie Vertrieb › Übersicht in der App).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bildschirmSession } from "@/lib/bildschirm";
import { ladeVertriebUebersicht } from "@/lib/vertrieb/uebersicht";
import type { BildschirmVertrieb } from "@/lib/bildschirm-typen";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await bildschirmSession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Bildschirm nicht verbunden" }, { status: 401 });
  }
  try {
    const body: BildschirmVertrieb = { success: true, ...(await ladeVertriebUebersicht(createAdminClient())) };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
