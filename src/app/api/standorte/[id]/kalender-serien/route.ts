// POST /api/standorte/[id]/kalender-serien — neue Veranstaltung (einmalig oder
// wiederkehrend, standort_serien). Body SerieEingabe → { success, id }.
// Recht locations:edit (Admin immer), nur Standorte mit partner_kalender;
// RLS-Client des Nutzers.

import { NextRequest, NextResponse } from "next/server";
import { serieAnlegen } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { internFehler, internKalenderGate } from "../kalender-gate";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: roh } = await params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  const body = await req.json().catch(() => null);
  try {
    const e = await serieAnlegen(k.supabase, k.standort.id, k.userId, body);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.standorte.kalender-serien", err, { standortId: k.standort.id });
    return internFehler("Veranstaltung konnte nicht gespeichert werden", 500);
  }
}
