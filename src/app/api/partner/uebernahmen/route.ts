// POST /api/partner/uebernahmen — «EVENTLINE uebernimmt alle
// Privatvermietungen von–bis» (standort_uebernahmen) eintragen. Body
// { von, bis, notiz } (YYYY-MM-DD, inklusiv) → { success, id }. Recht
// partner:belegungsplan:edit, nur Standorte mit locations.partner_kalender.

import { NextRequest, NextResponse } from "next/server";
import { partnerFehler } from "@/lib/partner-portal-server";
import { uebernahmeAnlegen } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { partnerKalenderGate } from "../kalender-gate";

export async function POST(req: NextRequest) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  const body = await req.json().catch(() => null);
  try {
    const e = await uebernahmeAnlegen(k.gate.admin, k.gate.standortId, k.gate.userId, body);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.partner.uebernahmen", err);
    return partnerFehler("Eintrag konnte nicht gespeichert werden", 500);
  }
}
