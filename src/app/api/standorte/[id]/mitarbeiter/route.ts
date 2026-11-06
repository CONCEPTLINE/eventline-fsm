// /api/standorte/[id]/mitarbeiter — EVENTLINE-Mitarbeitende, die an dieser
// Location eingeteilt sind (standort_mitarbeiter, Migration 384). Grundlage
// der Verfuegbarkeit im Kalender (src/lib/standort-verfuegbarkeit.ts).
//
// GET (locations:view, Admin immer) → { success, profileIds: string[] }
// PUT (nur Admin — wer heute Personal bearbeitet, Einstellungen › Mitarbeiter)
//     { profileIds: string[] } → { success, profileIds } — ersetzt die ganze
//     Liste. Nur aktive interne Konten (keine Portal-Konten).
// Lesen und Schreiben ueber den RLS-Client des Nutzers.

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { aktivePersonen, einteilungSetzen, standortMitarbeiterIds, uuidListePruefen } from "@/lib/standort-verfuegbarkeit";
import { logError } from "@/lib/log";
import { internFehler, internKalenderGate } from "../kalender-gate";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id: roh } = await params;
  const k = await internKalenderGate(roh, "locations:view");
  if (k.antwort) return k.antwort;
  try {
    const profileIds = await standortMitarbeiterIds(k.supabase, k.standort.id);
    return NextResponse.json({ success: true, profileIds });
  } catch (e) {
    logError("api.standorte.mitarbeiter.get", e, { standortId: k.standort.id });
    return internFehler("Eingeteilte Mitarbeiter konnten nicht geladen werden", 500);
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { id: roh } = await params;
  if (!isUuid(roh)) return internFehler("Ungültige ID", 400);
  const standortId = roh.toLowerCase();
  const body = (await req.json().catch(() => null)) as { profileIds?: unknown } | null;
  const p = uuidListePruefen(body?.profileIds, "profileIds");
  if (!p.ok) return internFehler(p.fehler, 400);

  try {
    const supabase = await createClient();
    const { data: loc, error: lErr } = await supabase.from("locations").select("id").eq("id", standortId).maybeSingle();
    if (lErr) throw lErr;
    if (!loc) return internFehler("Standort nicht gefunden", 404);
    // Neu Eingeteilte muessen aktive interne Konten sein (bereits Eingeteilte
    // duerfen bleiben, auch wenn sie inzwischen deaktiviert sind).
    const vorher = new Set(await standortMitarbeiterIds(supabase, standortId));
    const neu = p.ids.filter((id) => !vorher.has(id));
    const gueltig = new Set((await aktivePersonen(createAdminClient(), neu)).map((x) => x.id));
    if (neu.some((id) => !gueltig.has(id))) return internFehler("Nur aktive EVENTLINE-Mitarbeitende können eingeteilt werden", 400);

    const profileIds = await einteilungSetzen(supabase, "location", standortId, p.ids, auth.user.id);
    return NextResponse.json({ success: true, profileIds });
  } catch (e) {
    logError("api.standorte.mitarbeiter.put", e, { standortId });
    return internFehler("Einteilung konnte nicht gespeichert werden", 500);
  }
}
