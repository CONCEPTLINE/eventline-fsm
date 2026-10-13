// POST /api/technik/steuerung — Luefter-Profil des Rigs setzen (docs/technik-dashboard/VERTRAG.md §2.5).
// Nur Admins (requireAdmin wie alle Technik-Routen). Body: { "luefter_profil": "leise" | "ausgewogen" | "kuehl" }.
// Gespeichert in technik_steuerung (Migration 318, eine Zeile); das Rig holt das Profil mit der Antwort
// auf POST /api/technik/messwerte (alle 60 s) und meldet es als rig.kuehlung.profil_aktiv zurueck.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { istLuefterProfil } from "@/lib/technik-dashboard/steuerung";
import type { SteuerungStand } from "@/lib/technik-dashboard/typen";

export const dynamic = "force-dynamic";

const KEIN_CACHE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = (await request.json().catch(() => null)) as { luefter_profil?: unknown } | null;
  const profil = body?.luefter_profil;
  if (!istLuefterProfil(profil)) {
    return NextResponse.json({ success: false, error: "Unbekanntes Lüfter-Profil" }, { status: 400, headers: KEIN_CACHE });
  }

  const geaendert_am = new Date().toISOString();
  const { error } = await createAdminClient()
    .from("technik_steuerung")
    .upsert({ id: 1, luefter_profil: profil, geaendert_von: auth.user.id, geaendert_am }, { onConflict: "id" });
  if (error) {
    logError("technik.steuerung", error);
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500, headers: KEIN_CACHE });
  }
  const steuerung: SteuerungStand = { luefter_profil: profil, geaendert_am };
  return NextResponse.json({ success: true, steuerung }, { headers: KEIN_CACHE });
}
