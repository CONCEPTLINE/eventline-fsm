import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { reichereAn } from "@/lib/akquise-anreicherung";
import { KiFehler } from "@/lib/akquise-ki";

// Je Location bis zu sechs Seitenabrufe plus ein KI-Aufruf.
export const maxDuration = 300;

/**
 * POST /api/akquise/anreichern  { ids?: string[], limit?: number }
 *
 * Holt fuer die besten noch nicht angereicherten Kandidaten die Website
 * und zieht Ansprechpartner, Besetzung und Angebot daraus. Die Logik
 * liegt in `lib/akquise-anreicherung.ts`.
 */
export async function POST(req: NextRequest) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const ids: string[] | null = Array.isArray(body.ids) ? body.ids : null;
  const limit = Math.min(Number(body.limit) || 20, 40);

  const supabase = await createClient();
  let query = supabase
    .from("akquise_locations")
    .select("id, name, ort, website, flaeche");
  query = ids
    ? query.in("id", ids)
    : query.is("angereichert_am", null).neq("flaeche", "eigennutzung")
           .not("website", "is", null)
           .order("score", { ascending: false, nullsFirst: false });

  const { data: kandidaten, error } = await query.limit(limit);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!kandidaten?.length) {
    return NextResponse.json({ success: true, angereichert: 0, hinweis: "Nichts anzureichern." });
  }

  try {
    const r = await reichereAn(supabase, kandidaten);
    return NextResponse.json({
      success: true,
      angereichert: r.angereichert,
      ohne_befund: r.ohne_befund,
      ...(r.ohne_website.length ? { ohne_website: r.ohne_website } : {}),
    });
  } catch (e) {
    if (e instanceof KiFehler) {
      return NextResponse.json({ success: false, error: e.message }, { status: 502 });
    }
    throw e;
  }
}
