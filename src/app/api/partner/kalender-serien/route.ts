// POST /api/partner/kalender-serien — neue Veranstaltung (einmalig oder
// wiederkehrend, standort_serien) im Partner-Kalender. Body SerieEingabe
// (src/lib/standort-kalender.ts) → { success, id }. Recht
// partner:belegungsplan:edit, nur Standorte mit locations.partner_kalender.

import { NextRequest, NextResponse } from "next/server";
import { partnerFehler } from "@/lib/partner-portal-server";
import { serieAnlegen } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { partnerKalenderGate } from "../kalender-gate";

export async function POST(req: NextRequest) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  const body = await req.json().catch(() => null);
  try {
    const e = await serieAnlegen(k.gate.admin, k.gate.standortId, k.gate.userId, body);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.partner.kalender-serien", err);
    return partnerFehler("Veranstaltung konnte nicht gespeichert werden", 500);
  }
}
