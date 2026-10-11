import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { sucheLocations, OverpassFehler } from "@/lib/overpass";

// Overpass braucht fuer einen ganzen Kanton bis zu ~15s.
export const maxDuration = 90;

/**
 * POST /api/akquise/suchen  { gebiet: "Basel" }
 *
 * Holt Event-Locations aus OpenStreetMap und legt sie als Kandidaten ab.
 * Idempotent: ein zweiter Lauf fuegt nur Neues hinzu (upsert auf osm_id),
 * bestehende Bewertungen und Pins bleiben unberuehrt.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:create");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const gebiet = typeof body.gebiet === "string" ? body.gebiet.trim() : "";
  if (!gebiet) {
    return NextResponse.json({ success: false, error: "Kein Gebiet angegeben" }, { status: 400 });
  }

  let kandidaten;
  try {
    kandidaten = await sucheLocations(gebiet);
  } catch (e) {
    // Overpass-Ausfaelle sind erwartbar (Rate-Limit, Wartung) — als 503
    // melden, damit die UI "nochmal versuchen" sagen kann statt "Fehler".
    if (e instanceof OverpassFehler) {
      return NextResponse.json({ success: false, error: e.message }, { status: 503 });
    }
    throw e;
  }

  if (kandidaten.length === 0) {
    return NextResponse.json({
      success: true, gefunden: 0, neu: 0,
      hinweis: `Für «${gebiet}» hat OpenStreetMap keine Locations. Schreibweise prüfen (z. B. «Zürich» statt «Zuerich»).`,
    });
  }

  const supabase = await createClient();

  // Welche osm_ids kennen wir schon? Nur diese Teilmenge abfragen, nicht
  // die ganze Tabelle.
  const osmIds = kandidaten.map((k) => k.osm_id);
  const { data: bekannt } = await supabase
    .from("akquise_locations")
    .select("osm_id")
    .in("osm_id", osmIds);
  const schonDa = new Set((bekannt ?? []).map((r) => r.osm_id as string));

  const neue = kandidaten
    .filter((k) => !schonDa.has(k.osm_id))
    .map((k) => ({
      name: k.name,
      typ: k.typ,
      strasse: k.strasse,
      plz: k.plz,
      // OSM laesst addr:city oft leer — dann das Suchgebiet als Ort nehmen,
      // sonst verletzt die Zeile das NOT NULL und der ganze Insert fiele aus.
      ort: k.ort ?? gebiet,
      lat: k.lat,
      lng: k.lng,
      website: k.website,
      email: k.email,
      telefon: k.telefon,
      kapazitaet: k.kapazitaet,
      quelle: "osm" as const,
      osm_id: k.osm_id,
      recherchiert_am: new Date().toISOString(),
    }));

  if (neue.length > 0) {
    const { error } = await supabase.from("akquise_locations").insert(neue);
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    success: true,
    gefunden: kandidaten.length,
    neu: neue.length,
    bereits_bekannt: kandidaten.length - neue.length,
  });
}
