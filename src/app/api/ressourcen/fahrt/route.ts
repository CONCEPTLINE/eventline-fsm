// GET /api/ressourcen/fahrt → { success, zeiten: { <id>: { minuten, km } } }
//
// Ressourcen › Planungsbrett: Fahrzeit mit dem Auto vom Büro zu jeder aktiven
// Location mit Koordinaten und zu den vorgemerkten Häusern (Schlüssel
// «neu:<schluessel>»). Wer: vertrieb:view (Admin immer). Berechnung und
// Zwischenspeicher: src/lib/ressourcen/fahrt.ts. Nichts wird geschrieben.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ladeBuero, ladeFahrzeiten, type Punkt } from "@/lib/ressourcen/fahrt";
import { VORGEMERKTE_HAEUSER, VORGEMERKT_PRAEFIX } from "@/lib/ressourcen/haeuser";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

const KEIN_CACHE = { headers: { "Cache-Control": "no-store" } };

export async function GET() {
  const auth = await requirePermission("vertrieb:view");
  if (auth.error) return auth.error;

  try {
    const buero = await ladeBuero();
    if (!buero) return NextResponse.json({ success: false, error: "Die Büro-Adresse konnte nicht gefunden werden" }, { status: 502, ...KEIN_CACHE });

    const { data, error } = await createAdminClient()
      .from("locations")
      .select("id, latitude, longitude")
      .eq("is_active", true)
      .is("archived_at", null)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("id");
    if (error) throw error;

    const ziele: (Punkt & { id: string })[] = [];
    for (const z of (data ?? []) as { id: string; latitude: number | string; longitude: number | string }[]) {
      const lat = Number(z.latitude);
      const lng = Number(z.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) ziele.push({ id: z.id, lat, lng });
    }
    for (const h of VORGEMERKTE_HAEUSER) ziele.push({ id: `${VORGEMERKT_PRAEFIX}${h.schluessel}`, lat: h.latitude, lng: h.longitude });

    const zeiten = Object.fromEntries(await ladeFahrzeiten(buero, ziele));
    return NextResponse.json({ success: true, zeiten }, KEIN_CACHE);
  } catch (e) {
    logError("api.ressourcen.fahrt", e);
    return NextResponse.json({ success: false, error: "Die Fahrzeiten konnten nicht berechnet werden" }, { status: 502, ...KEIN_CACHE });
  }
}
