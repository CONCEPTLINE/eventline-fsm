// GET  /api/updates/seen — wann hat der eingeloggte User die App-
//                          Neuerungen zuletzt gesehen ({seen_at: ISO|null}).
// POST /api/updates/seen — markiert jetzt als gesehen (Popup geschlossen).
//
// Admin-Client statt direktem profiles-Update vom Client: unabhaengig
// davon, wie eng die profiles-RLS-Update-Policy ist. Im View-As-Modus
// (Impersonation, read-only) blockt der Middleware-Write-Guard den POST —
// das Popup faengt den Fehler still ab (kein Toast, Ambient-Feature).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("updates_seen_at")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, seen_at: data?.updates_seen_at ?? null });
}

export async function POST() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ updates_seen_at: new Date().toISOString() })
    .eq("id", auth.effectiveUserId);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
