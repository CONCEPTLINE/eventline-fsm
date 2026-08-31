// GET /api/analytics/locations?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Aggregation pro Location fuer Analytics-Uebersicht. Ohne Range =
// "alle Zeiten" (Firmen-Gruendung bis heute). Nutzt die SECURITY-DEFINER-
// RPC get_location_stats (Admin-Guard intern).
//
// Permission: strikt admin-only (Trust-Device + is_admin()-Guard in der RPC).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";

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
