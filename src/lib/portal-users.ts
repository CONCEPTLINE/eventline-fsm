// Gemeinsame Logik fuer das Anlegen von Portal-Usern (Partner/Lieferant/…).
//
// /api/admin/partner-users und /api/admin/lieferant-users waren 97-Zeilen-
// Kopien voneinander (Diff: nur FK-Spalte partner_location_id vs
// lieferant_id + Texte). Beide Routen sind jetzt duenne Wrapper um
// createPortalUser() — URLs und Response-Formate unveraendert. Ein
// drittes Portal braucht nur noch eine neue Route + Config.
//
// Ablauf (identisch zum bisherigen Copy-Paste-Stand):
//   1. requireAdmin
//   2. Body validieren (email, full_name, FK-Pflichtfeld)
//   3. FK-Referenz (Location/Lieferanten-Firma) muss existieren
//   4. Email-Pre-Check gegen profiles
//   5. Auth-User mit fixer Portal-Rolle anlegen (Helper aus /api/admin/users)
//   6. FK-Spalte am Profil setzen (Trigger weiss nichts davon)
//   7. Setup-Mail (Reset-Link, /passwort-reset-Flow)

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { createAuthUser, sendSetupMail } from "@/app/api/admin/users/route";
import type { PortalSlug } from "@/lib/portals";

export interface PortalUserCreateConfig {
  /** Fixe Rolle des neuen Users, z.B. "partner". */
  role: PortalSlug;
  /** Pflicht-FK im Request-Body UND profiles-Spalte, z.B. "partner_location_id". */
  fkColumn: string;
  /** Tabelle auf die der FK zeigt, z.B. "locations". */
  fkTable: string;
  /** Fehlertext wenn der FK im Body fehlt. */
  fkRequiredError: string;
  /** Fehlertext wenn die FK-Referenz nicht existiert. */
  fkNotFoundError: string;
  /** Fehlertext wenn das FK-Update am Profil scheitert. */
  fkAssignError: string;
  /** logError-Key fuer das gescheiterte FK-Update. */
  logAssignKey: string;
  /** logError-Key fuer die Exception im catch. */
  logExceptionKey: string;
}

export async function createPortalUser(
  request: Request,
  cfg: PortalUserCreateConfig,
): Promise<NextResponse> {
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
    const fkValue = typeof body[cfg.fkColumn] === "string" ? (body[cfg.fkColumn] as string) : "";

    if (!email || !full_name) {
      return NextResponse.json({ success: false, error: "Email und Name sind Pflicht" }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: "Ungültige Email-Adresse" }, { status: 400 });
    }
    if (!fkValue) {
      return NextResponse.json({ success: false, error: cfg.fkRequiredError }, { status: 400 });
    }

    const admin = createAdminClient();

    // FK-Referenz (Location / Lieferanten-Firma) muss existieren
    const { data: ref } = await admin
      .from(cfg.fkTable)
      .select("id, name")
      .eq("id", fkValue)
      .maybeSingle();
    if (!ref) {
      return NextResponse.json({ success: false, error: cfg.fkNotFoundError }, { status: 400 });
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

    const created = await createAuthUser({ supabaseUrl, serviceKey, email, fullName: full_name, role: cfg.role });
    if (!created.success) {
      return NextResponse.json({ success: false, error: created.error }, { status: 400 });
    }

    // FK-Spalte setzen (Trigger weiss nichts davon)
    const { error: fkUpdateErr } = await admin
      .from("profiles")
      .update({ [cfg.fkColumn]: fkValue })
      .eq("id", created.userId);
    if (fkUpdateErr) {
      logError(cfg.logAssignKey, fkUpdateErr, { userId: created.userId });
      return NextResponse.json({ success: false, error: cfg.fkAssignError }, { status: 500 });
    }

    // Setup-Mail wie bei /api/admin/users (Reset-Link mit Eventline-Branding).
    // Setup-Mail nutzt denselben /passwort-reset-Flow — der Portal-User setzt
    // sein Passwort dort und loggt sich danach auf seinem Portal-Login ein.
    const mail = await sendSetupMail({ supabaseUrl, serviceKey, email, fullName: full_name });

    return NextResponse.json({
      success: true,
      userId: created.userId,
      mail_warning: mail.success ? undefined : mail.error,
    });
  } catch (e) {
    logError(cfg.logExceptionKey, e);
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : "Interner Fehler" }, { status: 500 });
  }
}
