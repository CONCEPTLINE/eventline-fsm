// POST /api/hr/wage-documents/accept-digital
// Mitarbeiter akzeptiert digitale Bereitstellung seiner Lohndokumente.
// Setzt Timestamp + Version auf profiles.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const WAGE_DIGITAL_CONSENT_VERSION = "1.0";

export async function POST() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

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
