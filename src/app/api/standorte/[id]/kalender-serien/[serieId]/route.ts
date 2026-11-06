// /api/standorte/[id]/kalender-serien/[serieId] — Veranstaltung aendern oder
// loeschen (Recht locations:edit, Admin immer; nur Standorte mit
// partner_kalender; RLS-Client).
//
// PATCH  { umfang: "serie" | "nur_diesen", serienTag?, eingabe: SerieEingabe }
// DELETE ?umfang=serie|nur_diesen&serienTag=YYYY-MM-DD
// 409 = Serie wurde zwischenzeitlich geaendert (neu laden).

import { NextRequest, NextResponse } from "next/server";
import { serieAendern, serieLoeschen } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { internFehler, internKalenderGate } from "../../kalender-gate";

type Ctx = { params: Promise<{ id: string; serieId: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id: roh, serieId } = await params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  const body = await req.json().catch(() => null);
  try {
    const e = await serieAendern(k.supabase, k.standort.id, serieId, body);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.standorte.kalender-serien.patch", err, { standortId: k.standort.id, serieId });
    return internFehler("Veranstaltung konnte nicht gespeichert werden", 500);
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id: roh, serieId } = await params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  const sp = req.nextUrl.searchParams;
  try {
    const e = await serieLoeschen(k.supabase, k.standort.id, serieId, sp.get("umfang"), sp.get("serienTag"));
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.standorte.kalender-serien.delete", err, { standortId: k.standort.id, serieId });
    return internFehler("Veranstaltung konnte nicht gelöscht werden", 500);
  }
}
