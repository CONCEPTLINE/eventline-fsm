// GET   /api/analytics/locations?from=YYYY-MM-DD&to=YYYY-MM-DD  — Aggregation
// PATCH /api/analytics/locations                                — Stundensatz setzen
//
// Aggregation pro Location fuer Analytics-Uebersicht. Ohne Range =
// "alle Zeiten" (Firmen-Gruendung bis heute). Nutzt die SECURITY-DEFINER-
// RPC get_location_stats (Admin-Guard intern).
//
// Permission: strikt admin-only (Trust-Device + is_admin()-Guard in der RPC).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function isDate(s: string | null): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export async function GET(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  // User-Client damit is_admin() innerhalb der RPC den echten User sieht
  // (service-role wuerde auth.uid()=null liefern und den Guard sprengen).
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_location_stats", {
    p_from: isDate(from) ? from : "2000-01-01",
    p_to: isDate(to) ? to : "9999-12-31",
  });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, rows: data ?? [] });
}

// PATCH: setzt locations.default_hourly_rate_chf. Body: {location_id, rate|null}.
// null = Satz loeschen (Umsatz/Marge werden dann in der UI ausgeblendet).
export async function PATCH(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.location_id !== "string") {
    return NextResponse.json({ success: false, error: "location_id fehlt" }, { status: 400 });
  }

  let rate: number | null = null;
  if (body.rate !== null && body.rate !== undefined && body.rate !== "") {
    const n = typeof body.rate === "number" ? body.rate : Number(body.rate);
    if (!Number.isFinite(n) || n < 0 || n > 99999.99) {
      return NextResponse.json({ success: false, error: "Stundensatz ungueltig (0 - 99999.99)" }, { status: 400 });
    }
    rate = n;
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("locations")
    .update({ default_hourly_rate_chf: rate })
    .eq("id", body.location_id);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
