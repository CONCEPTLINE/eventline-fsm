// GET /api/akquise/[id]/pdf          → interne Bedarfsanalyse
// GET /api/akquise/[id]/pdf?teil=konzept → Kooperationskonzept für die Location
//
// Der Build liegt in src/lib/build-akquise-pdf.ts.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { buildAkquisePdf, akquisePdfName, type PdfTeil } from "@/lib/build-akquise-pdf";
import type { AkquiseLocation } from "@/types/akquise";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePermission("vertrieb:view");
  if (auth.error) return auth.error;
  const { id } = await params;

  const teil: PdfTeil =
    new URL(request.url).searchParams.get("teil") === "konzept" ? "konzept" : "analyse";

  // User-Client, damit die RLS auf akquise_locations greift.
  const userClient = await createClient();
  const { data } = await userClient
    .from("akquise_locations").select("*").eq("id", id).single();
  if (!data) {
    return NextResponse.json(
      { error: "Location nicht gefunden oder keine Berechtigung" },
      { status: 404 },
    );
  }
  const location = data as AkquiseLocation;

  // Was nicht erzeugt wurde, kann nicht gedruckt werden — klar sagen statt
  // ein leeres PDF ausliefern.
  if (teil === "analyse" && !location.bedarfsanalyse) {
    return NextResponse.json({ error: "Für diese Location gibt es noch keine Bedarfsanalyse" }, { status: 400 });
  }
  if (teil === "konzept" && !location.kooperationskonzept) {
    return NextResponse.json({ error: "Für diese Location gibt es noch kein Kooperationskonzept" }, { status: 400 });
  }

  // Admin-Client nur für die Firmen-Stammdaten (Logo/Footer) — die liegen
  // ausserhalb der Sichtbarkeit des Users.
  const pdf = await buildAkquisePdf(location, teil, createAdminClient());

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${akquisePdfName(location, teil)}"`,
    },
  });
}
