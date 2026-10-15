// /api/dev/impersonate — Steuer-Endpoint fuer Developer-Mode View-As.
//
//   POST   body { target_user_id: string }
//     Startet oder wechselt die Impersonation. Setzt IMPERSONATE_COOKIE.
//     Erlaubt nur wenn der eingeloggte User Admin ist UND
//     profiles.developer_mode_enabled=true.
//
//   DELETE  Stoppt die Impersonation (loescht Cookie). Immer erlaubt —
//           man muss auch aus dem View-As wieder rauskommen koennen.
//
//   GET     Liefert den aktuellen Zustand: { active, target_user_id, target }
//           Nur Admin + Developer-Mode (sonst 401/403).
//
// Der Write-Guard in src/middleware.ts erlaubt POST + DELETE auf DIESEN
// Endpoint auch waehrend aktiver Impersonation — sonst kaeme man nicht raus.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser, IMPERSONATE_COOKIE, IMPERSONATE_WRITE_COOKIE } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function requireDeveloperMode() {
  const auth = await requireUser();
  if (auth.error) return { error: auth.error, user: null };
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
    return {
      error: NextResponse.json(
        { success: false, error: "Developer Mode ist nicht aktiviert" },
        { status: 403 },
      ),
      user: null,
    };
  }
  return { user: auth.user, error: null };
}

export async function GET() {
  // Status nur fuer Admins mit aktivem Developer-Mode (wie POST und
  // /candidates). Vorher ohne jede Anmeldung: Name + Rolle zu jeder UUID im
  // frei setzbaren Cookie. Das View-As-Overlay fragt ohnehin nur in diesem
  // Zustand ab.
  const gate = await requireDeveloperMode();
  if (gate.error) return gate.error;
  const store = await cookies();
  const targetId = store.get(IMPERSONATE_COOKIE)?.value ?? null;
  if (!targetId) {
    return NextResponse.json({ active: false });
  }
  const admin = createAdminClient();
  const { data: target } = await admin
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", targetId)
    .maybeSingle();
  const writeEnabled = store.get(IMPERSONATE_WRITE_COOKIE)?.value === "1";
  return NextResponse.json({
    active: true,
    target_user_id: targetId,
    target,
    write_enabled: writeEnabled,
  });
}

export async function POST(request: Request) {
  const gate = await requireDeveloperMode();
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => null);
  const targetId = (body as { target_user_id?: unknown } | null)?.target_user_id;
  if (typeof targetId !== "string" || targetId.length === 0) {
    return NextResponse.json(
      { success: false, error: "target_user_id fehlt" },
      { status: 400 },
    );
  }
  if (targetId === gate.user!.id) {
    return NextResponse.json(
      { success: false, error: "Kann sich nicht selbst impersonieren" },
      { status: 400 },
    );
  }
  const admin = createAdminClient();
  const { data: target } = await admin
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", targetId)
    .maybeSingle();
  if (!target) {
    return NextResponse.json(
      { success: false, error: "Ziel-User existiert nicht" },
      { status: 404 },
    );
  }
  const store = await cookies();
  store.set(IMPERSONATE_COOKIE, targetId, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Session-Cookie (kein maxAge) — nur solange Browser offen.
  });
  // Bei jedem Wechsel/Start: Write-Modus zuruecksetzen. Der Admin muss
  // pro Ziel-User bewusst neu 'Bearbeitung aktivieren' bestaetigen.
  store.delete(IMPERSONATE_WRITE_COOKIE);
  return NextResponse.json({ success: true, target });
}

export async function DELETE() {
  const store = await cookies();
  store.delete(IMPERSONATE_COOKIE);
  store.delete(IMPERSONATE_WRITE_COOKIE);
  return NextResponse.json({ success: true });
}
