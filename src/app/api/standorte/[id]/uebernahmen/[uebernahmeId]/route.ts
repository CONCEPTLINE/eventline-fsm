// /api/standorte/[id]/uebernahmen/[uebernahmeId] — «EVENTLINE uebernimmt»
// aendern (PATCH { von, bis, notiz }) oder loeschen (DELETE). Recht
// locations:edit (Admin immer), nur Standorte mit partner_kalender; RLS-Client.

import { NextRequest, NextResponse } from "next/server";
import { uebernahmeAendern, uebernahmeLoeschen } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { internFehler, internKalenderGate } from "../../kalender-gate";

type Ctx = { params: Promise<{ id: string; uebernahmeId: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id: roh, uebernahmeId } = await params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  const body = await req.json().catch(() => null);
  try {
    const e = await uebernahmeAendern(k.supabase, k.standort.id, uebernahmeId, body);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.standorte.uebernahmen.patch", err, { standortId: k.standort.id, uebernahmeId });
    return internFehler("Eintrag konnte nicht gespeichert werden", 500);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id: roh, uebernahmeId } = await params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  try {
    const e = await uebernahmeLoeschen(k.supabase, k.standort.id, uebernahmeId);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.standorte.uebernahmen.delete", err, { standortId: k.standort.id, uebernahmeId });
    return internFehler("Eintrag konnte nicht gelöscht werden", 500);
  }
}
