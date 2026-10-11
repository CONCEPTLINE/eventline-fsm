import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { tiefenRecherche } from "@/lib/akquise-tiefenrecherche";
import { KiFehler } from "@/lib/akquise-ki";
import type { AkquiseLocation } from "@/types/akquise";

// Bis zu acht Websuchen plus zwei KI-Aufrufe fuer EIN Haus.
export const maxDuration = 180;

/**
 * POST /api/akquise/umfeld  { id }
 *
 * Recherchiert ein einzelnes Haus im Netz: Presse, Finanzierung,
 * Personalwechsel, laufende Veraenderungen, Partner, Auslastung.
 *
 * Bewusst eine eigene Route und nicht Teil der Suche: pro Haus dauert
 * das gut zwei Minuten, fuer zwanzig waere der Suchlauf eine Stunde.
 * Die Oberflaeche ruft sie auf, sobald jemand eine Location oeffnet —
 * dann fuer genau diese eine, und nur beim ersten Mal.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ success: false, error: "Keine id" }, { status: 400 });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("akquise_locations").select("*").eq("id", id).single();
  if (error || !data) {
    return NextResponse.json({ success: false, error: "Location nicht gefunden" }, { status: 404 });
  }
  const location = data as AkquiseLocation;

  // Schon recherchiert: nichts erneut ausgeben lassen.
  if (location.recherche?.umfeld) {
    return NextResponse.json({ success: true, umfeld: location.recherche.umfeld, aus_cache: true });
  }

  let umfeld;
  try {
    umfeld = await tiefenRecherche(location.name, location.ort, location.website);
  } catch (e) {
    if (e instanceof KiFehler) {
      return NextResponse.json({ success: false, error: e.message }, { status: 502 });
    }
    throw e;
  }

  const recherche = { ...(location.recherche ?? {}), umfeld };
  const { error: schreibFehler } = await supabase
    .from("akquise_locations").update({ recherche }).eq("id", id);
  if (schreibFehler) {
    return NextResponse.json({ success: false, error: schreibFehler.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, umfeld });
}
