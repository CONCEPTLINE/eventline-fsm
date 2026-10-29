// Lohn-Einstellungen (Lohn-Umbau Phase 1), Tabelle lohn_einstellungen.
//
// GET /api/hr/lohn-einstellungen  — Vertretung + «Lauf ab» (nur Admins)
// PUT /api/hr/lohn-einstellungen  — Body { vertretung_profile_id: uuid | null }
//                                    nur Admins auf vertrautem Gerät; im
//                                    Rechte-Protokoll festgehalten.
//
// Die Vertretung darf wie der andere Admin neue Geräte freigeben und den Lohn
// von Personen mit Lohnrecht ändern (Vier Augen) — nie den eigenen.

import { NextResponse } from "next/server";
import { requireAdmin, requireAdminTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logPermissionAudit } from "@/lib/permission-audit";
import { LOHN_RECHT, ladeLohnEinstellungen } from "@/lib/lohn/zugriff";
import { monatSchluessel } from "@/lib/lohn/monate";
import { isUuid } from "@/lib/search-escape";
import { istIntern } from "@/lib/roles";

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const e = await ladeLohnEinstellungen(createAdminClient());
    return NextResponse.json({
      success: true,
      vertretung_profile_id: e.vertretungProfileId,
      vertretung_name: e.vertretungName,
      lauf_ab: monatSchluessel(e.laufAb),
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdminTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  if (auth.isImpersonating) return NextResponse.json({ success: false, error: "Nicht in «Ansicht als»." }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { vertretung_profile_id?: unknown } | null;
  const neu = body?.vertretung_profile_id ?? null;
  if (neu !== null && (typeof neu !== "string" || !isUuid(neu))) {
    return NextResponse.json({ success: false, error: "vertretung_profile_id ungültig" }, { status: 400 });
  }

  const admin = createAdminClient();
  let name: string | null = null;
  if (neu) {
    const { data: p, error } = await admin.from("profiles").select("full_name, role, is_active").eq("id", neu).maybeSingle();
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    if (!p || p.is_active !== true || !istIntern(p.role as string)) {
      return NextResponse.json({ success: false, error: "Vertretung muss eine aktive EVENTLINE-Person sein." }, { status: 400 });
    }
    name = (p.full_name as string | null) ?? null;
  }
  const { data: me } = await admin.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
  const { error } = await admin
    .from("lohn_einstellungen")
    .update({
      vertretung_profile_id: neu,
      vertretung_name: name,
      updated_at: new Date().toISOString(),
      updated_by: auth.user.id,
      updated_by_name: (me?.full_name as string | null) ?? null,
    })
    .eq("id", "default");
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  await logPermissionAudit({
    actor_profile_id: auth.user.id,
    action: "lohn.vertretung_changed",
    target_profile_id: neu ?? auth.user.id,
    details: { vertretung: name },
  });
  return NextResponse.json({ success: true, vertretung_profile_id: neu, vertretung_name: name });
}
