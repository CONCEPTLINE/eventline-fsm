// GET /api/technik/leistung?zeitraum=7d|30d|alle — Abschnitt «Leistung» im KI-Panel der Seite /technik
// (docs/technik-dashboard/VERTRAG.md §6.5). Nur Admins. Nur Zahlen und Zeitpunkte, keine Namen/Inhalte.
//
// Rig-Teil: gespeicherter Stand (rig.leistung, alle 10 min vom Sammler). FSM-Teil: technik_leistung()
// (Migration 335), gecacht 60 s je Zeitraum — Statistik, die Seite fragt hoechstens alle 5 min.

import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { LEISTUNG_ZEITRAUM_STANDARD } from "@/lib/technik-dashboard/konstanten";
import { baueLeistung, istLeistungZeitraum, ladeFsmLeistung, ladeRigLeistung, zeitraumVon } from "@/lib/technik-dashboard/leistung";
import type { LeistungZeitraum } from "@/lib/technik-dashboard/typen";

export const dynamic = "force-dynamic";

const KEIN_CACHE = { "Cache-Control": "no-store" };

/** Zaehlungen im FSM je Zeitraum, 60 s im Server-Cache (Admin-Client, keine Request-Daten im Cache). */
const fsmLeistung = unstable_cache(
  async (zeitraum: LeistungZeitraum) => ladeFsmLeistung(createAdminClient(), zeitraumVon(zeitraum, new Date())),
  ["technik-leistung-fsm"],
  { revalidate: 60 },
);

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const roh = new URL(request.url).searchParams.get("zeitraum");
  const zeitraum: LeistungZeitraum = istLeistungZeitraum(roh) ? roh : LEISTUNG_ZEITRAUM_STANDARD;

  try {
    const [rig, fsm] = await Promise.all([ladeRigLeistung(createAdminClient()), fsmLeistung(zeitraum)]);
    return NextResponse.json(baueLeistung({ rig, fsm, zeitraum, jetzt: new Date() }), { headers: KEIN_CACHE });
  } catch (e) {
    logError("technik.leistung", e);
    return NextResponse.json(
      { success: false, error: "Leistung konnte nicht geladen werden" },
      { status: 500, headers: KEIN_CACHE },
    );
  }
}
