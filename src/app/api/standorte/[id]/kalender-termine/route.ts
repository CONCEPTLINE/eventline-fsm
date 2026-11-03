// POST /api/standorte/[id]/kalender-termine — eigene Termine eines Standorts
// intern anlegen, aendern, loeschen (Recht locations:edit, Admin immer; nur
// Standorte mit locations.partner_kalender). Gleiches Body-Format wie
// /api/partner/kalender-termine:
//
// POST { aktion: "anlegen", titel, kunde, start, ende, ganztaegig, notiz } → { success, id }
// POST { aktion: "aendern", id, titel, kunde, start, ende, ganztaegig, notiz }
// POST { aktion: "loeschen", id }
//
// Schreibt ueber den RLS-Client des Nutzers (Policies standort_termine_*,
// Migration 382) und nur Termine DIESES Standorts.

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { terminAktionAusfuehren } from "@/lib/standort-kalender";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

const fehler = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("locations:edit");
  if (auth.error) return auth.error;
  const { id: roh } = await params;
  if (!isUuid(roh)) return fehler("Ungültige ID", 400);
  const standortId = roh.toLowerCase();
  const body = await req.json().catch(() => null);

  try {
    const supabase = await createClient();
    const { data: standort, error: sErr } = await supabase
      .from("locations")
      .select("partner_kalender")
      .eq("id", standortId)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!standort) return fehler("Standort nicht gefunden", 404);
    if ((standort as { partner_kalender: boolean | null }).partner_kalender !== true) {
      return fehler("Der Kalender ist für diesen Standort nicht freigeschaltet", 403);
    }

    const ergebnis = await terminAktionAusfuehren(supabase, standortId, auth.user.id, body);
    return NextResponse.json(ergebnis.body, { status: ergebnis.status });
  } catch (e) {
    logError("api.standorte.kalender-termine", e, { standortId, aktion: (body as { aktion?: unknown } | null)?.aktion });
    return fehler("Termin konnte nicht gespeichert werden", 500);
  }
}
