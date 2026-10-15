import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";

// POST — firmenweites Calendar-Token rotieren.
//
// Wenn das Firma-Token leakt (kopierte URL in Slack, Browser-History, externer
// Geraete-Cache), invalidet dieser Endpoint den alten und vergibt einen
// neuen. Alle abonnierten iCal-Subscriptions (Geschaeftsleitung, Sekretariat,
// etc.) muessen danach manuell neu eingerichtet werden — sie zeigen sonst
// einen "401 Token ungueltig"-Error in den Calendar-Apps.
//
// Admin-only. Persoenliche Tokens (profile_calendar_tokens) bleiben
// unberuehrt — die rotiert jeder User selbst ueber /api/profile/rotate-calendar-token.

export async function POST() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const newToken = crypto.randomUUID();

  const { error } = await admin
    .from("app_settings")
    .update({ company_calendar_token: newToken })
    .eq("id", 1);

  if (error) {
    logError("api.company.rotate-calendar-token", error, { userId: auth.user.id });
    return NextResponse.json({ success: false, error: "Token-Rotation fehlgeschlagen" }, { status: 500 });
  }

  return NextResponse.json({ success: true, token: newToken });
}
