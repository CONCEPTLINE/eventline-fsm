// POST /api/partner/kalender-termine — eigene Termine des Standorts im
// Partner-Kalender anlegen, aendern, loeschen (Recht
// partner:belegungsplan:edit, nur Standorte mit locations.partner_kalender).
//
// POST { aktion: "anlegen", titel, kunde, start, ende, ganztaegig, notiz } → { success, id }
// POST { aktion: "aendern", id, titel, kunde, start, ende, ganztaegig, notiz }
// POST { aktion: "loeschen", id }
//
// Nur Termine des EIGENEN Standorts (location_id = gate.standortId); fremde
// und nicht vorhandene sind gleichermassen «nicht gefunden».

import { NextRequest, NextResponse } from "next/server";
import { requirePartnerPortal, partnerFehler } from "@/lib/partner-portal-server";
import { terminAktionAusfuehren } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";

export async function POST(req: NextRequest) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darf("partner:belegungsplan:edit")) return partnerFehler("Keine Berechtigung für diese Aktion", 403);
  const body = await req.json().catch(() => null);

  try {
    const { data: standort, error: sErr } = await gate.admin
      .from("locations")
      .select("partner_kalender")
      .eq("id", gate.standortId)
      .maybeSingle();
    if (sErr) throw sErr;
    if ((standort as { partner_kalender: boolean | null } | null)?.partner_kalender !== true) {
      return partnerFehler("Der Kalender ist für diesen Standort nicht freigeschaltet", 403);
    }

    const ergebnis = await terminAktionAusfuehren(gate.admin, gate.standortId, gate.userId, body);
    return NextResponse.json(ergebnis.body, { status: ergebnis.status });
  } catch (e) {
    logError("api.partner.kalender-termine", e, { aktion: (body as { aktion?: unknown } | null)?.aktion });
    return partnerFehler("Termin konnte nicht gespeichert werden", 500);
  }
}
