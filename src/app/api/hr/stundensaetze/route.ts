// GET /api/hr/stundensaetze?ids=<uuid,uuid,…>
// → { saetze: { [profile_id]: hourly_wage_chf } } — aktuell offene Lohnzeile.
//
// Für die Kosten-Prognose auf der Projekt-Seite. Früher las die Seite
// employee_compensation direkt im Browser; seit dem Lohn-Umbau Phase 1 nur
// noch über den Server mit Lohnrecht UND vertrautem Gerät (wie die Finanzen).
// Ohne Recht/Gerät antwortet die Route 403 — die Seite zeigt dann keine Kosten.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { isUuid } from "@/lib/search-escape";

export async function GET(request: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").filter(isUuid).slice(0, 500);
  if (ids.length === 0) return NextResponse.json({ success: true, saetze: {} });

  const { data, error } = await createAdminClient()
    .from("employee_compensation")
    .select("profile_id, hourly_wage_chf")
    .in("profile_id", ids)
    .is("effective_to", null);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  const saetze: Record<string, number> = {};
  for (const c of data ?? []) saetze[c.profile_id as string] = Number(c.hourly_wage_chf);
  return NextResponse.json({ success: true, saetze });
}
