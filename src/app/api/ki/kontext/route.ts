import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { ladeNachtKontext } from "@/lib/ki/kontext";
import { rigAuthFehler } from "@/lib/ki/rig-auth";

// GET /api/ki/kontext — Kontext der Nachtarbeit fuer das Rig
// (docs/lokale-ki/MASTERPLAN.md §3.5). Das Rig holt ihn vor jeder Job-Phase
// und nach je 50 Schritten; aelter als 60 min startet kein Job.
//   { erzeugt_am, heute, ordner, dok_typen, mitarbeiter, namen_alle,
//     vorschlaege_bekannt: [{ art, pfad, status }], fristen_bekannt: [{ pfad, art, datum, status }] }
// ordner/dok_typen/mitarbeiter/namen_alle aus derselben Funktion wie bei
// ablage_analyse (lib/ki/kontext), hier streng: ein Lesefehler -> 500,
// nie eine leere Ordnerliste. Keine Nebenwirkung. Auth: Bearer KI_SYNC_TOKEN.

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const authFehler = rigAuthFehler(request);
  if (authFehler) return authFehler;
  try {
    const kontext = await ladeNachtKontext(createAdminClient());
    return NextResponse.json(kontext, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    logError("ki.kontext", e);
    return NextResponse.json({ success: false, error: "Kontext konnte nicht geladen werden" }, { status: 500 });
  }
}
