// POST /api/admin/lieferant-users — Lieferanten-User anlegen.
// Wie /api/admin/users, aber:
//   - Rolle fix 'lieferant'
//   - lieferant_id ist Pflicht
//   - Reset-Mail geht an /lieferant/login statt /login
//
// Setup-Mail nutzt den gleichen Helper wie /api/admin/users.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { createAuthUser, sendSetupMail } from "@/app/api/admin/users/route";

export async function POST(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ success: false, error: "Server-Konfiguration unvollstaendig" }, { status: 500 });
    }

    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ success: false, error: "Ungültiger Body" }, { status: 400 });

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const full_name = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const lieferant_id = typeof body.lieferant_id === "string" ? body.lieferant_id : "";

    if (!email || !full_name) {
      return NextResponse.json({ success: false, error: "Email und Name sind Pflicht" }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: "Ungültige Email-Adresse" }, { status: 400 });
    }
    if (!lieferant_id) {
      return NextResponse.json({ success: false, error: "Lieferanten-Firma ist Pflicht" }, { status: 400 });
    }

    const admin = createAdminClient();

    // Lieferant muss existieren
    const { data: lief } = await admin
      .from("lieferanten")
      .select("id, name")
      .eq("id", lieferant_id)
      .maybeSingle();
    if (!lief) {
      return NextResponse.json({ success: false, error: "Lieferant nicht gefunden" }, { status: 400 });
    }

    // Pre-Check Email
    const { data: existing } = await admin
      .from("profiles")
      .select("id, email, is_active")
      .eq("email", email)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { success: false, error: `Es gibt bereits einen Benutzer mit Email ${email}` },
        { status: 400 },
      );
    }

    const created = await createAuthUser({ supabaseUrl, serviceKey, email, fullName: full_name, role: "lieferant" });
    if (!created.success) {
      return NextResponse.json({ success: false, error: created.error }, { status: 400 });
    }

    // lieferant_id setzen (Trigger weiss nichts davon)
    const { error: liefUpdateErr } = await admin
      .from("profiles")
      .update({ lieferant_id })
      .eq("id", created.userId);
    if (liefUpdateErr) {
      logError("admin.lieferant-users.lieferant-update", liefUpdateErr, { userId: created.userId });
      return NextResponse.json({ success: false, error: "Lieferanten-Firma konnte nicht zugewiesen werden" }, { status: 500 });
    }

    // Setup-Mail wie bei /api/admin/users (Reset-Link mit Eventline-Branding).
    // Setup-Mail nutzt denselben /passwort-reset-Flow — der Lieferant setzt
    // sein Passwort dort und loggt sich danach auf /lieferant/login ein.
    const mail = await sendSetupMail({ supabaseUrl, serviceKey, email, fullName: full_name });

    return NextResponse.json({
      success: true,
      userId: created.userId,
      mail_warning: mail.success ? undefined : mail.error,
    });
  } catch (e) {
    logError("admin.lieferant-users.exception", e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : "Interner Fehler" }, { status: 500 });
  }
}
