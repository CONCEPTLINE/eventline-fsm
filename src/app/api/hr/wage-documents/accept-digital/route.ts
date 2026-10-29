// POST /api/hr/wage-documents/accept-digital
// Mitarbeiter akzeptiert digitale Bereitstellung seiner Lohndokumente.
// Setzt Timestamp + Version auf profiles und hält die Wahl «digital» in der
// Historie fest (lohn_zustellung_wahl, quelle «selbst», Phase 4).
//
// Nur die Person SELBST (Phase 1): immer das echte angemeldete Konto, nie in
// «Ansicht als» — auch nicht mit freigeschalteter Bearbeitung.
// Papier statt digital: POST /api/hr/lohn-zustellung { wahl: "papier" }.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { DIGITAL_EINWILLIGUNG_VERSION, speichereWahl } from "@/lib/lohn/zustellung";

export const WAGE_DIGITAL_CONSENT_VERSION = DIGITAL_EINWILLIGUNG_VERSION;

export async function POST() {
  const auth = await requireUser({ wartung: "lohn" });
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return NextResponse.json(
      { success: false, error: "Die Einwilligung gibt nur die Person selbst — nicht in «Ansicht als»." },
      { status: 403 },
    );
  }

  const admin = createAdminClient();
  try {
    const { data: me } = await admin.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
    await speichereWahl(admin, {
      profileId: auth.user.id,
      wahl: "digital",
      quelle: "selbst",
      akteurId: auth.user.id,
      akteurName: (me?.full_name as string | null) ?? null,
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
