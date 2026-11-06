// Gemeinsames Gate der internen Kalender-Routen eines Standorts (kein Route
// Handler — nur route.ts-Dateien sind oeffentlich): Recht locations:view bzw.
// locations:edit (Admin immer), gueltige Standort-ID, Standort per RLS-Client
// sichtbar; zum Schreiben zusaetzlich locations.partner_kalender.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { standortKalenderLaden, type StandortKalenderInfo } from "@/lib/standort-kalender";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

export const internFehler = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

export type InternKalenderGate =
  | { antwort: NextResponse }
  | { antwort: null; supabase: SupabaseClient; standort: StandortKalenderInfo; userId: string };

export async function internKalenderGate(
  idRoh: string,
  recht: "locations:view" | "locations:edit",
): Promise<InternKalenderGate> {
  const auth = await requirePermission(recht);
  if (auth.error) return { antwort: auth.error };
  if (!isUuid(idRoh)) return { antwort: internFehler("Ungültige ID", 400) };
  try {
    const supabase = await createClient();
    const standort = await standortKalenderLaden(supabase, idRoh.toLowerCase());
    if (!standort) return { antwort: internFehler("Standort nicht gefunden", 404) };
    if (recht === "locations:edit" && !standort.partner_kalender) {
      return { antwort: internFehler("Der Kalender ist für diesen Standort nicht freigeschaltet", 403) };
    }
    return { antwort: null, supabase, standort, userId: auth.user.id };
  } catch (e) {
    logError("api.standorte.kalender-gate", e);
    return { antwort: internFehler("Laden fehlgeschlagen", 500) };
  }
}
