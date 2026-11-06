// POST /api/standorte/[id]/uebernahmen — «EVENTLINE uebernimmt alle
// Privatvermietungen von–bis» eintragen. Body { von, bis, notiz } →
// { success, id }. Recht locations:edit (Admin immer), nur Standorte mit
// partner_kalender; RLS-Client.

import { NextRequest, NextResponse } from "next/server";
import { uebernahmeAnlegen } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { internFehler, internKalenderGate } from "../kalender-gate";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: roh } = await params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  const body = await req.json().catch(() => null);
  try {
    const e = await uebernahmeAnlegen(k.supabase, k.standort.id, k.userId, body);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.standorte.uebernahmen", err, { standortId: k.standort.id });
    return internFehler("Eintrag konnte nicht gespeichert werden", 500);
  }
}
