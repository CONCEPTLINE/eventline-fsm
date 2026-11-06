// /api/standorte/[id]/programmheft — Programmheft der Website (vorerst
// Barakuba, src/lib/programmheft.ts) mit dem Standort-Kalender abgleichen.
// Gleiche Formen wie /api/partner/programmheft. RLS-Client des Nutzers.
//
// GET   (locations:view) → { success, funde: ProgrammFund[], quelle, auto, abgeglichenAm }
// POST  (locations:edit, nur partner_kalender) { quelleIds: string[] } → { success, neu, aktualisiert }
// PATCH (locations:edit, nur partner_kalender) { auto: boolean } → { success }
// Website-Probleme → 502 mit Klartext.

import { NextRequest, NextResponse } from "next/server";
import {
  autoPruefen,
  ProgrammheftFehler,
  programmheftImport,
  programmheftQuelle,
  programmheftStand,
  quelleIdsPruefen,
} from "@/lib/programmheft";
import { logError } from "@/lib/log";
import { internFehler, internKalenderGate } from "../kalender-gate";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id: roh } = await params;
  const k = await internKalenderGate(roh, "locations:view");
  if (k.antwort) return k.antwort;
  try {
    const stand = await programmheftStand(k.supabase, k.standort);
    return NextResponse.json({ success: true, ...stand });
  } catch (e) {
    if (e instanceof ProgrammheftFehler) return internFehler(e.message, 502);
    logError("api.standorte.programmheft.get", e, { standortId: k.standort.id });
    return internFehler("Programmheft konnte nicht geladen werden", 500);
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id: roh } = await params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  const p = quelleIdsPruefen(await req.json().catch(() => null));
  if (!p.ok) return internFehler(p.fehler, 400);
  try {
    const r = await programmheftImport(k.supabase, k.standort, k.userId, p.ids);
    return NextResponse.json({ success: true, neu: r.neu, aktualisiert: r.aktualisiert });
  } catch (e) {
    if (e instanceof ProgrammheftFehler) return internFehler(e.message, 502);
    logError("api.standorte.programmheft.post", e, { standortId: k.standort.id });
    return internFehler("Programm konnte nicht übernommen werden", 500);
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id: roh } = await params;
  const k = await internKalenderGate(roh, "locations:edit");
  if (k.antwort) return k.antwort;
  const auto = autoPruefen(await req.json().catch(() => null));
  if (auto === null) return internFehler("Ungültige Angabe «auto»", 400);
  if (!programmheftQuelle(k.standort.name)) return internFehler("Für diesen Standort ist kein Programmheft hinterlegt", 404);
  try {
    const { count, error } = await k.supabase
      .from("locations")
      .update({ programmheft_auto: auto }, { count: "exact" })
      .eq("id", k.standort.id);
    if (error) throw error;
    if (!count) return internFehler("Keine Berechtigung für diese Aktion", 403);
    return NextResponse.json({ success: true });
  } catch (e) {
    logError("api.standorte.programmheft.patch", e, { standortId: k.standort.id });
    return internFehler("Einstellung konnte nicht gespeichert werden", 500);
  }
}
