// POST /api/hr/wage-documents/accept-digital
// Mitarbeiter akzeptiert digitale Bereitstellung seiner Lohndokumente.
// Setzt Timestamp + Version auf profiles.
//
// Nur die Person SELBST (Phase 1): immer das echte angemeldete Konto, nie in
// «Ansicht als» — auch nicht mit freigeschalteter Bearbeitung.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const WAGE_DIGITAL_CONSENT_VERSION = "1.0";

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
  const { error } = await admin
    .from("profiles")
    .update({
      lohndokumente_digital_accepted_at: new Date().toISOString(),
      lohndokumente_digital_accepted_version: WAGE_DIGITAL_CONSENT_VERSION,
    })
    .eq("id", auth.user.id);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
