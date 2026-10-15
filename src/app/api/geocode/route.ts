// Single-Row-Geocode: liest Adresse von locations/rooms, ruft Nominatim,
// schreibt latitude/longitude zurueck. Gedacht als fire-and-forget vom
// Insert-Form aus.
//
// Body: { table: "locations" | "rooms", id: string }

import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { geocodeAddress } from "@/lib/geocode";

const ALLOWED_TABLES = new Set(["locations", "rooms"]);

export async function POST(req: NextRequest) {
  // Wer Locations/Raeume anlegen oder bearbeiten darf (Aufruf nach dem
  // Anlegen) — die Route ueberschreibt Koordinaten per Admin-Client.
  const auth = await requireAnyPermission(["locations:create", "locations:edit"]);
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const { table, id } = body as { table?: string; id?: string };
  if (!table || !id || !ALLOWED_TABLES.has(table)) {
    return NextResponse.json({ ok: false, error: "bad input" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row, error: fetchErr } = await admin
    .from(table)
    .select("address_street, address_zip, address_city")
    .eq("id", id)
    .single();
  if (fetchErr || !row) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const coords = await geocodeAddress(
    (row as { address_street: string | null }).address_street,
    (row as { address_zip: string | null }).address_zip,
    (row as { address_city: string | null }).address_city,
  );
  if (!coords) {
    return NextResponse.json({ ok: false, reason: "no-match" });
  }

  const { error: updateErr } = await admin
    .from(table)
    .update({ latitude: coords.lat, longitude: coords.lng })
    .eq("id", id);
  if (updateErr) {
    return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, coords });
}
