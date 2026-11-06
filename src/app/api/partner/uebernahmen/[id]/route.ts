// /api/partner/uebernahmen/[id] — «EVENTLINE uebernimmt» des eigenen
// Standorts aendern (PATCH { von, bis, notiz }) oder loeschen (DELETE).
// Recht partner:belegungsplan:edit, nur Standorte mit partner_kalender.

import { NextRequest, NextResponse } from "next/server";
import { partnerFehler } from "@/lib/partner-portal-server";
import { uebernahmeAendern, uebernahmeLoeschen } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { partnerKalenderGate } from "../../kalender-gate";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  try {
    const e = await uebernahmeAendern(k.gate.admin, k.gate.standortId, id, body);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.partner.uebernahmen.patch", err, { id });
    return partnerFehler("Eintrag konnte nicht gespeichert werden", 500);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  const { id } = await params;
  try {
    const e = await uebernahmeLoeschen(k.gate.admin, k.gate.standortId, id);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.partner.uebernahmen.delete", err, { id });
    return partnerFehler("Eintrag konnte nicht gelöscht werden", 500);
  }
}
