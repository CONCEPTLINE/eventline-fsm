import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { bewerteLocations, type ZuBewerten } from "@/lib/akquise-bewertung";

// Mehrere Locations in einem Durchgang — das dauert.
export const maxDuration = 300;

/**
 * POST /api/akquise/bewerten  { ids?: string[] }
 *
 * Ohne ids: alle noch unbewerteten Kandidaten. Die Logik liegt in
 * `lib/akquise-bewertung.ts`, damit die Suche sie direkt mitlaufen lassen
 * kann.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { success: false, error: "ANTHROPIC_API_KEY ist nicht gesetzt" },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const ids: string[] | null = Array.isArray(body.ids) ? body.ids : null;

  const supabase = await createClient();
  let query = supabase
    .from("akquise_locations")
    .select("id, name, typ, strasse, ort, website, kapazitaet");
  query = ids ? query.in("id", ids) : query.is("score", null);
  const { data: offen, error } = await query.limit(200);

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!offen?.length) {
    return NextResponse.json({ success: true, bewertet: 0, hinweis: "Nichts zu bewerten." });
  }

  const { bewertet, fehler } = await bewerteLocations(supabase, offen as ZuBewerten[]);
  return NextResponse.json({
    success: true, bewertet, offen: offen.length - bewertet,
    ...(fehler.length ? { fehler } : {}),
  });
}
