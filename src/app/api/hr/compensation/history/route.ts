// GET /api/hr/compensation/history?profile_id=<uuid>
//
// Komplette Lohn-Historie eines Mitarbeiters (alle employee_compensation-
// Zeilen, neueste zuerst). Fuer die Historie-Ansicht im Lohn-Editor:
// wann wurde von X auf Y erhoeht, mit welcher Notiz.
//
// Bewusst nur die Anzeige-Felder (Brutto + Fenster + Notiz + Modus) —
// die Pct-Details der Historie braucht das UI nicht.
// Permission: lohn:manage (+ Trusted Device), wie die Haupt-Route.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireTrustedDevice } from "@/lib/api-auth";

export async function GET(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const profileId = url.searchParams.get("profile_id");
  if (!profileId) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("employee_compensation")
    .select("id, hourly_wage_chf, wage_exempt, uses_standard_lohn, effective_from, effective_to, notes, created_at")
    .eq("profile_id", profileId)
    .order("effective_from", { ascending: false });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    history: (data ?? []).map((r) => ({
      id: r.id,
      hourly_wage_chf: Number(r.hourly_wage_chf),
      wage_exempt: (r as { wage_exempt?: boolean }).wage_exempt === true,
      uses_standard_lohn: r.uses_standard_lohn !== false,
      effective_from: r.effective_from,
      effective_to: r.effective_to,
      notes: r.notes,
    })),
  });
}
