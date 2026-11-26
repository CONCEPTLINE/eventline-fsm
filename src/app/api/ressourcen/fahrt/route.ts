// GET /api/ressourcen/fahrt            → { success, buero }
// GET /api/ressourcen/fahrt?id=<uuid>  → { success, buero, ziel, fahrt, maps }
//
// Vertrieb › Ressourcen: Büro-Standort und schnellste Autostrecke vom Büro zu
// einer Location. Wer: vertrieb:view (Admin immer). Berechnung und
// Zwischenspeicher: src/lib/ressourcen/fahrt.ts. Hat die Location noch keine
// Koordinaten, wird ihre Adresse für diese Antwort aufgelöst (nichts wird
// in die Datenbank geschrieben).

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { geocodeAddress } from "@/lib/geocode";
import { googleMapsLink, ladeBuero, ladeFahrt, type Punkt } from "@/lib/ressourcen/fahrt";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

const KEIN_CACHE = { headers: { "Cache-Control": "no-store" } };

function fehler(error: string, status: number) {
  return NextResponse.json({ success: false, error }, { status, ...KEIN_CACHE });
}

export async function GET(req: NextRequest) {
  const auth = await requirePermission("vertrieb:view");
  if (auth.error) return auth.error;

  const buero = await ladeBuero();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ success: true, buero }, KEIN_CACHE);
  if (!isUuid(id)) return fehler("Ungültige ID", 400);
  if (!buero) return fehler("Die Büro-Adresse konnte nicht gefunden werden", 502);

  try {
    const { data, error } = await createAdminClient()
      .from("locations")
      .select("id, address_street, address_zip, address_city, latitude, longitude")
      .eq("id", id.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    if (!data) return fehler("Location nicht gefunden", 404);

    const lat = Number(data.latitude);
    const lng = Number(data.longitude);
    let ziel: Punkt | null =
      data.latitude != null && data.longitude != null && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    if (!ziel) {
      ziel = await geocodeAddress(
        data.address_street as string | null,
        data.address_zip as string | null,
        data.address_city as string | null,
      );
    }
    if (!ziel) return fehler("Die Adresse dieser Location konnte nicht gefunden werden", 422);

    const maps = googleMapsLink(buero, ziel);
    try {
      const fahrt = await ladeFahrt(buero, ziel);
      return NextResponse.json({ success: true, buero, ziel, fahrt, maps }, KEIN_CACHE);
    } catch (e) {
      // Routendienst nicht erreichbar: Ziel und Google-Link trotzdem liefern.
      logError("api.ressourcen.fahrt.osrm", e, { locationId: id });
      return NextResponse.json({ success: true, buero, ziel, fahrt: null, maps }, KEIN_CACHE);
    }
  } catch (e) {
    logError("api.ressourcen.fahrt", e, { locationId: id });
    return fehler("Die Strecke konnte nicht berechnet werden", 500);
  }
}
