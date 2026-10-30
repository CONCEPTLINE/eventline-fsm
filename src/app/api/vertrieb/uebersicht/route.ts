// GET /api/vertrieb/uebersicht — Vertrieb › Übersicht (Leo 2026-10-30):
// derselbe Grundsatz-Überblick wie auf dem Buero-Bildschirm, fuer alle mit
// vertrieb:view. Berechnung: src/lib/vertrieb/uebersicht.ts.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ladeVertriebUebersicht } from "@/lib/vertrieb/uebersicht";
import type { BildschirmVertrieb } from "@/lib/bildschirm-typen";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePermission("vertrieb:view");
  if (auth.error) return auth.error;
  try {
    const body: BildschirmVertrieb = { success: true, ...(await ladeVertriebUebersicht(createAdminClient())) };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
