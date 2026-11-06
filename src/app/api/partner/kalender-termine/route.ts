// /api/partner/kalender-termine — eigene Termine (und Programm-Termine) des
// Standorts im Partner-Kalender anlegen, aendern, loeschen (Recht
// partner:belegungsplan:edit, nur Standorte mit locations.partner_kalender).
//
// POST { aktion: "anlegen", titel, kunde, start, ende, ganztaegig, notiz } → { success, id }
// POST { aktion: "aendern", id, titel, kunde, start, ende, ganztaegig, notiz }
// POST { aktion: "loeschen", id }
// gleichwertig: PATCH { id, titel, … } (aendern) · DELETE ?id= (loeschen)
//
// Nur Termine des EIGENEN Standorts (location_id = gate.standortId); fremde
// und nicht vorhandene sind gleichermassen «nicht gefunden».

import { NextRequest, NextResponse } from "next/server";
import { partnerFehler } from "@/lib/partner-portal-server";
import { terminAktionAusfuehren, terminBodyMitAktion } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { partnerKalenderGate } from "../kalender-gate";

async function ausfuehren(body: unknown) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  try {
    const ergebnis = await terminAktionAusfuehren(k.gate.admin, k.gate.standortId, k.gate.userId, body);
    return NextResponse.json(ergebnis.body, { status: ergebnis.status });
  } catch (e) {
    logError("api.partner.kalender-termine", e, { aktion: (body as { aktion?: unknown } | null)?.aktion });
    return partnerFehler("Termin konnte nicht gespeichert werden", 500);
  }
}

export async function POST(req: NextRequest) {
  return ausfuehren(await req.json().catch(() => null));
}

export async function PATCH(req: NextRequest) {
  return ausfuehren(terminBodyMitAktion("aendern", await req.json().catch(() => null), null));
}

export async function DELETE(req: NextRequest) {
  return ausfuehren(terminBodyMitAktion("loeschen", null, req.nextUrl.searchParams.get("id")));
}
