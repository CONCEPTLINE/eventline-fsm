// /api/personal/[id]/standorte — Locations, an denen eine Person eingeteilt
// ist (standort_mitarbeiter, Migration 384). Gegenstueck zu
// /api/standorte/[id]/mitarbeiter; genutzt im Bearbeiten-Dialog der
// Mitarbeiter-Verwaltung (Einstellungen › Firmenportal › Mitarbeiter, deren
// Schreib-Routen unter /api/admin/users liegen und requireAdmin verlangen).
//
// GET (locations:view oder Admin — wie die RLS-Policy) → { success, locationIds: string[] }
// PUT (nur Admin) { locationIds: string[] } → { success, locationIds } — ersetzt die
//     ganze Liste. Person muss ein internes Konto sein.
// Lesen und Schreiben ueber den RLS-Client des Nutzers.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireInternal } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { istPortalRolle } from "@/lib/portals";
import { isUuid } from "@/lib/search-escape";
import { einteilungSetzen, uuidListePruefen } from "@/lib/standort-verfuegbarkeit";
import { logError } from "@/lib/log";

const fehler = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const { id: roh } = await params;
  if (!isUuid(roh)) return fehler("Ungültige ID", 400);
  try {
    const supabase = await createClient();
    // RLS (standort_mitarbeiter_select): locations:view oder Admin — ohne
    // Recht kommt eine leere Liste, nie fremde Daten.
    const { data, error } = await supabase
      .from("standort_mitarbeiter")
      .select("location_id")
      .eq("profile_id", roh.toLowerCase());
    if (error) throw error;
    return NextResponse.json({ success: true, locationIds: ((data ?? []) as { location_id: string }[]).map((z) => z.location_id) });
  } catch (e) {
    logError("api.personal.standorte.get", e, { profileId: roh });
    return fehler("Locations konnten nicht geladen werden", 500);
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { id: roh } = await params;
  if (!isUuid(roh)) return fehler("Ungültige ID", 400);
  const profileId = roh.toLowerCase();
  const body = (await req.json().catch(() => null)) as { locationIds?: unknown } | null;
  const p = uuidListePruefen(body?.locationIds, "locationIds");
  if (!p.ok) return fehler(p.fehler, 400);

  try {
    const supabase = await createClient();
    const { data: person, error: pErr } = await createAdminClient()
      .from("profiles")
      .select("id, role")
      .eq("id", profileId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!person) return fehler("Person nicht gefunden", 404);
    if (istPortalRolle((person as { role: string | null }).role)) {
      return fehler("Nur EVENTLINE-Mitarbeitende können eingeteilt werden", 400);
    }
    if (p.ids.length > 0) {
      const { data: locs, error: lErr } = await supabase.from("locations").select("id").in("id", p.ids);
      if (lErr) throw lErr;
      if ((locs ?? []).length !== p.ids.length) return fehler("Unbekannte Location in der Auswahl", 400);
    }
    const locationIds = await einteilungSetzen(supabase, "person", profileId, p.ids, auth.user.id);
    return NextResponse.json({ success: true, locationIds });
  } catch (e) {
    logError("api.personal.standorte.put", e, { profileId });
    return fehler("Locations konnten nicht gespeichert werden", 500);
  }
}
