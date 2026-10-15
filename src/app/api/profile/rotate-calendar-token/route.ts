import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";

// POST — eigenen Kalender-Schluessel rotieren (bzw. anlegen, falls noch keiner
// existiert).
//
// Wenn der Token leakt (kopierte URL in Slack, Browser-History, externer
// Geraete-Cache), invalidet dieser Endpoint den alten und vergibt einen
// neuen. Alle bestehenden iCal-Subscriptions (Google/Apple/Outlook) muessen
// danach aktualisiert werden — die zeigen sonst einen "401 Token ungueltig"-
// Error in den Calendar-Apps.
//
// Seit Migration 329 liegt der Schluessel in profile_calendar_tokens (eine
// Zeile je Profil), nicht mehr in profiles.calendar_feed_token.

export async function POST() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  // Token wird im Node-Runtime via crypto.randomUUID generiert.
  const newToken = crypto.randomUUID();

  const { error: updateErr } = await admin
    .from("profile_calendar_tokens")
    .upsert(
      { user_id: auth.user.id, token: newToken, created_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );

  if (updateErr) {
    logError("api.profile.rotate-calendar-token", updateErr, { userId: auth.user.id });
    return NextResponse.json({ success: false, error: "Token-Rotation fehlgeschlagen" }, { status: 500 });
  }

  return NextResponse.json({ success: true, token: newToken });
}
