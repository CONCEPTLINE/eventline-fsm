import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bexioContactUrl, getContactById } from "@/lib/bexio";
import { requirePermission } from "@/lib/api-auth";

// POST { customerId, bexioContactId, bexioNr? }
//
// Verknuepft einen Eventline-Kunden mit einem existierenden Bexio-Kontakt.
// Wird vom Match-Modal aufgerufen wenn der User einen Kandidaten auswaehlt
// statt neu anzulegen.
//
// bexioNr: optional — wenn das Frontend die Nummer aus der Match-Suche schon
// hat, sparen wir uns den extra GET-Call. Sonst holen wir sie via getContactById.
//
// Service-Role-Update damit RLS nicht blockt.
export async function POST(request: NextRequest) {
  try {
    const auth = await requirePermission("bexio:use");
    if (auth.error) return auth.error;
    const { customerId, bexioContactId, bexioNr } = await request.json();
    if (!customerId || !bexioContactId) {
      return NextResponse.json(
        { success: false, error: "customerId + bexioContactId noetig" },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // Mehrfach-Verknuepfung ist ERLAUBT (Leo 2026-09-23): ein Verein mit
    // Person A als Kontakt und Person A privat sind zwei Kunden, duerfen
    // aber denselben Bexio-Kontakt (Rechnungsempfaenger) teilen. Wir
    // blockieren nicht, geben aber eine Info mit, damit es bewusst
    // passiert.
    const { data: schonVerknuepft } = await admin
      .from("customers")
      .select("id, name")
      .eq("bexio_contact_id", String(bexioContactId))
      .neq("id", customerId)
      .limit(1)
      .maybeSingle();
    const hinweis = schonVerknuepft
      ? `Hinweis: Dieser Bexio-Kontakt ist auch mit «${schonVerknuepft.name}» verknüpft — beide Kunden teilen jetzt dieselbe Bexio-Nr.`
      : null;

    // Wenn nr nicht mitkam — vom Bexio-Kontakt nachladen.
    let nr: string | null = bexioNr ?? null;
    if (!nr) {
      const contact = await getContactById(parseInt(String(bexioContactId), 10));
      nr = contact?.nr ?? null;
    }
    const { error } = await admin
      .from("customers")
      .update({
        bexio_contact_id: String(bexioContactId),
        bexio_nr: nr,
      })
      .eq("id", customerId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      bexioNr: nr,
      bexioContactUrl: bexioContactUrl(parseInt(String(bexioContactId), 10)),
      hinweis,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
