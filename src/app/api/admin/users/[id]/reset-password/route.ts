// POST /api/admin/users/[id]/reset-password — schickt einen Passwort-
// Reset-Link an die Mail-Adresse des Users via Resend (zuverlaessiger
// als Supabase's Default-Mailer). Klickt der User darauf, landet er auf
// /passwort-reset und kann sich selbst ein neues Passwort setzen.
// Admin sieht das Passwort nie.
//
// Self-Healing fuer "orphan profiles": wenn ein Profil in profiles
// existiert, der zugehoerige auth.users-Eintrag aber nicht (z.B. weil
// der Auth-User mal manuell im Dashboard geloescht wurde), wuerde
// generate_link mit "user_not_found" scheitern. In dem Fall raeumen wir
// das verwaiste Profil auf und legen den Auth-User neu an — der Trigger
// handle_new_user erstellt dann ein frisches Profil. Damit fuehrt der
// Reset-Button NIE in eine Sackgasse, auch nach Schema-Drift.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { sendSetupMail, createAuthUser } from "../../route";
import { logError } from "@/lib/log";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin({ wartung: "rechte" });
  if (auth.error) return auth.error;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { success: false, error: "Server-Konfiguration unvollstaendig" },
      { status: 500 },
    );
  }

  const { id } = await params;
  const admin = createAdminClient();

  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("email, full_name, role")
    .eq("id", id)
    .single();

  if (profErr || !profile?.email) {
    return NextResponse.json({ success: false, error: "Profil nicht gefunden" }, { status: 404 });
  }

  const fullName = profile.full_name ?? profile.email;
  const role = profile.role ?? "techniker";

  const result = await sendSetupMail({
    supabaseUrl,
    serviceKey,
    email: profile.email,
    fullName,
  });

  if (result.success) {
    return NextResponse.json({ success: true, email: profile.email });
  }

  // Self-Healing: auth.users-Row fehlt (orphan profile). Profil loeschen,
  // Auth-User neu anlegen, Setup-Mail nochmal versuchen. FK-Cascades sind
  // im Schema vorhanden (016_protect_data: assigned_to/profile_id ON
  // DELETE SET NULL, notifications ON DELETE CASCADE).
  const isOrphan = result.error?.includes("user_not_found")
    || result.error?.includes("\"code\":404");
  if (!isOrphan) {
    logError("admin.users.reset-password", { error: result.error }, { email: profile.email });
    return NextResponse.json(
      { success: false, error: result.error ?? "Reset-Mail konnte nicht versendet werden" },
      { status: 500 },
    );
  }

  logError("admin.users.reset-password.orphan-detected", { profileId: id }, { email: profile.email });

  const { error: delErr } = await admin.from("profiles").delete().eq("id", id);
  if (delErr) {
    logError("admin.users.reset-password.orphan-delete", delErr, { email: profile.email });
    return NextResponse.json(
      { success: false, error: `Verwaistes Profil konnte nicht aufgeraeumt werden: ${delErr.message}` },
      { status: 500 },
    );
  }

  const created = await createAuthUser({
    supabaseUrl,
    serviceKey,
    email: profile.email,
    fullName,
    role,
  });
  if (!created.success) {
    logError("admin.users.reset-password.recreate", { error: created.error }, { email: profile.email });
    return NextResponse.json(
      { success: false, error: `Auth-User konnte nicht neu angelegt werden: ${created.error}` },
      { status: 500 },
    );
  }

  const retry = await sendSetupMail({
    supabaseUrl,
    serviceKey,
    email: profile.email,
    fullName,
  });
  if (!retry.success) {
    logError("admin.users.reset-password.retry-mail", { error: retry.error }, { email: profile.email });
    return NextResponse.json(
      { success: false, error: retry.error ?? "Reset-Mail konnte nicht versendet werden" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, email: profile.email, repaired: true });
}
