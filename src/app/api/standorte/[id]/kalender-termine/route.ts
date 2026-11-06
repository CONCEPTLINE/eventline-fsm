// /api/standorte/[id]/kalender-termine — eigene Termine (und Programm-Termine)
// eines Standorts intern anlegen, aendern, loeschen (Recht locations:edit,
// Admin immer; nur Standorte mit locations.partner_kalender). Gleiche Formen
// wie /api/partner/kalender-termine:
//
// POST { aktion: "anlegen", titel, kunde, start, ende, ganztaegig, notiz } → { success, id }
// POST { aktion: "aendern", id, titel, kunde, start, ende, ganztaegig, notiz }
// POST { aktion: "loeschen", id }
// gleichwertig: PATCH { id, titel, … } (aendern) · DELETE ?id= (loeschen)
//
// Schreibt ueber den RLS-Client des Nutzers (Policies standort_termine_*,
// Migration 382) und nur Termine DIESES Standorts.

import { NextRequest, NextResponse } from "next/server";
import { terminAktionAusfuehren, terminBodyMitAktion } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";
import { internFehler, internKalenderGate } from "../kalender-gate";

type Ctx = { params: Promise<{ id: string }> };

async function ausfuehren(ctx: Ctx, body: unknown) {
  const { id: roh } = await ctx.params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  try {
    const ergebnis = await terminAktionAusfuehren(k.supabase, k.standort.id, k.userId, body);
    return NextResponse.json(ergebnis.body, { status: ergebnis.status });
  } catch (e) {
    logError("api.standorte.kalender-termine", e, {
      standortId: k.standort.id,
      aktion: (body as { aktion?: unknown } | null)?.aktion,
    });
    return internFehler("Termin konnte nicht gespeichert werden", 500);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return ausfuehren(ctx, await req.json().catch(() => null));
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  return ausfuehren(ctx, terminBodyMitAktion("aendern", await req.json().catch(() => null), null));
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return ausfuehren(ctx, terminBodyMitAktion("loeschen", null, req.nextUrl.searchParams.get("id")));
}
