// /api/dev/impersonate/write — schaltet den Write-Modus waehrend einer
// aktiven Impersonation ein oder aus.
//
//   POST { enabled: boolean }
//     enabled=true  → setzt IMPERSONATE_WRITE_COOKIE="1"
//                     → Middleware laesst POST/PUT/PATCH/DELETE zu
//     enabled=false → loescht das Write-Cookie → wieder read-only
//
// Zwingt eine aktive Impersonation als Vorbedingung — man kann Write
// nicht "auf Vorrat" einschalten. Ausserdem: nur Admin mit
// developer_mode_enabled=true (analog zu /api/dev/impersonate).

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser, IMPERSONATE_COOKIE, IMPERSONATE_WRITE_COOKIE } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logPermissionAudit } from "@/lib/permission-audit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, developer_mode_enabled")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (
    !profile ||
    profile.role !== "admin" ||
    profile.developer_mode_enabled !== true
  ) {
    return NextResponse.json(
      { success: false, error: "Developer Mode nicht aktiv" },
      { status: 403 },
    );
  }

  const store = await cookies();
  const impersonating = store.get(IMPERSONATE_COOKIE)?.value;
  if (!impersonating) {
    return NextResponse.json(
      { success: false, error: "Keine Impersonation aktiv" },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => null);
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json(
      { success: false, error: "enabled (boolean) fehlt" },
      { status: 400 },
    );
  }

  // Rechte-Protokoll: Bearbeitung in «Ansicht als» an/aus (Lohn-Umbau Phase 1).
  const protokolliert = await logPermissionAudit({
    actor_profile_id: auth.user.id,
    action: enabled ? "view_as.write_enabled" : "view_as.write_disabled",
    target_profile_id: impersonating,
  });
  if (enabled && !protokolliert) {
    return NextResponse.json(
      { success: false, error: "Bearbeitung konnte nicht protokolliert werden — nicht freigeschaltet." },
      { status: 500 },
    );
  }

  if (enabled) {
    store.set(IMPERSONATE_WRITE_COOKIE, "1", {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
  } else {
    store.delete(IMPERSONATE_WRITE_COOKIE);
  }

  return NextResponse.json({ success: true, write_enabled: enabled });
}
