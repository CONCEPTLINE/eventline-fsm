// GET /api/technik/stand?bereich=6h|24h|7d&reihen=0|1 — Stand fuer die Seite
// /technik (docs/technik-dashboard/VERTRAG.md §6.2). Nur Admins.
// Ampeln, Ereignisse und (bei reihen=1) Kurven in einer Antwort.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { BEREICHE } from "@/lib/technik-dashboard/konstanten";
import { ladeTechnikStand } from "@/lib/technik-dashboard/stand-server";
import type { Bereich } from "@/lib/technik-dashboard/typen";

export const dynamic = "force-dynamic";

const KEIN_CACHE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const params = new URL(request.url).searchParams;
  const roh = params.get("bereich");
  const bereich: Bereich = (BEREICHE as readonly string[]).includes(roh ?? "") ? (roh as Bereich) : "6h";
  const reihen = params.get("reihen") === "1";

  try {
    const stand = await ladeTechnikStand(createAdminClient(), { bereich, reihen });
    return NextResponse.json(stand, { headers: KEIN_CACHE });
  } catch (e) {
    logError("technik.stand", e);
    return NextResponse.json(
      { success: false, error: "Technik-Stand konnte nicht geladen werden" },
      { status: 500, headers: KEIN_CACHE },
    );
  }
}
