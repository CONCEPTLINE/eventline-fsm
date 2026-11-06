// /api/partner/kalender-serien/[id] — Veranstaltung des eigenen Standorts
// aendern oder loeschen (Recht partner:belegungsplan:edit, nur Standorte mit
// locations.partner_kalender).
//
// PATCH  { umfang: "serie" | "nur_diesen", serienTag?, eingabe: SerieEingabe }
// DELETE ?umfang=serie|nur_diesen&serienTag=YYYY-MM-DD
// «nur_diesen» braucht serienTag (urspruenglicher Tag der Instanz). 409 =
// Serie wurde zwischenzeitlich geaendert (neu laden).

import { NextRequest, NextResponse } from "next/server";
import { partnerFehler } from "@/lib/partner-portal-server";
import { serieAendern, serieLoeschen } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { partnerKalenderGate } from "../../kalender-gate";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  try {
    const e = await serieAendern(k.gate.admin, k.gate.standortId, id, body);
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.partner.kalender-serien.patch", err, { id });
    return partnerFehler("Veranstaltung konnte nicht gespeichert werden", 500);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  try {
    const e = await serieLoeschen(k.gate.admin, k.gate.standortId, id, sp.get("umfang"), sp.get("serienTag"));
    return NextResponse.json(e.body, { status: e.status });
  } catch (err) {
    logError("api.partner.kalender-serien.delete", err, { id });
    return partnerFehler("Veranstaltung konnte nicht gelöscht werden", 500);
  }
}
