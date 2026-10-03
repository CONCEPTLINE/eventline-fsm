// PATCH /api/admin/roles/[slug] — Label, Permissions, Sichtbarkeit (scope)
//   oder Dashboard-Schalter (dashboard_bereiche_aus) aendern.
// DELETE /api/admin/roles/[slug] — Rolle loeschen.
//
// admin-Rolle ist geschuetzt: weder permissions noch slug aenderbar, nicht
// loeschbar. Sonst koennten sich Admins selbst aussperren.
// is_system-Rollen (admin, techniker) koennen nicht geloescht werden, aber
// ihre Permissions koennen angepasst werden (ausser admin).

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLES_TAG } from "@/lib/cached";
import { requireAdmin } from "@/lib/api-auth";
import { allKnownPermissions } from "@/lib/permissions";
import { logPermissionAudit } from "@/lib/permission-audit";
import { DASHBOARD_BEREICH_KEYS, istDashboardBereich } from "@/lib/dashboard-bereiche";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { slug } = await params;
  if (slug === "admin") {
    return NextResponse.json({ success: false, error: "Admin-Rolle kann nicht geaendert werden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungültiger Body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.label === "string" && body.label.trim()) {
    update.label = body.label.trim();
  }
  if (Array.isArray(body.permissions)) {
    const valid = new Set(allKnownPermissions());
    update.permissions = (body.permissions as unknown[]).filter((s): s is string => typeof s === "string" && valid.has(s));
  }
  // scope: Zugriffs-Reichweite der Rolle (siehe Migration 208).
  //   'self' = nur eigene Datensaetze (Default)
  //   'team' = zusaetzlich Datensaetze der Mitarbeiter mit team_lead_id = ich
  //   'all'  = alle Datensaetze
  // Wird von sees_user()/get_my_scope() gelesen und in RLS als
  // zusaetzlicher PERMISSIVE-Zweig ausgewertet.
  if (typeof body.scope === "string") {
    if (body.scope !== "self" && body.scope !== "team" && body.scope !== "all") {
      return NextResponse.json({ success: false, error: "scope ungültig (self/team/all)" }, { status: 400 });
    }
    update.scope = body.scope;
  }
  // dashboard_bereiche_aus: Liste der Dashboard-Bereiche, die fuer diese
  // Rolle AUS geschaltet sind (Migration 290, src/lib/dashboard-bereiche.ts).
  // Leere Liste = alles an, was die Rechte erlauben. Unbekannte Keys → 400;
  // gespeichert dedupliziert in der festen Bereich-Reihenfolge.
  if (Object.prototype.hasOwnProperty.call(body, "dashboard_bereiche_aus")) {
    const aus = (body as { dashboard_bereiche_aus: unknown }).dashboard_bereiche_aus;
    if (!Array.isArray(aus)) {
      return NextResponse.json({ success: false, error: "dashboard_bereiche_aus muss eine Liste sein" }, { status: 400 });
    }
    const unbekannt = (aus as unknown[]).filter((k) => !istDashboardBereich(k));
    if (unbekannt.length > 0) {
      return NextResponse.json(
        { success: false, error: `Unbekannter Dashboard-Bereich: ${unbekannt.map((k) => String(k)).join(", ")}` },
        { status: 400 },
      );
    }
    const gewaehlt = new Set<string>(aus as string[]);
    update.dashboard_bereiche_aus = DASHBOARD_BEREICH_KEYS.filter((k) => gewaehlt.has(k));
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: false, error: "Keine Änderungen" }, { status: 400 });
  }

  const admin = createAdminClient();
  // Vorher-Zustand fuer Audit-Diff laden.
  const { data: before } = await admin
    .from("roles")
    .select("label, permissions, dashboard_bereiche_aus, scope")
    .eq("slug", slug)
    .maybeSingle();
  const { error } = await admin.from("roles").update(update).eq("slug", slug);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  // §9-Rollen-Cache sofort invalidieren (me/dashboard lesen via cachedRoles()).
  revalidateTag(ROLES_TAG, { expire: 0 });

  await logPermissionAudit({
    actor_profile_id: auth.user.id,
    action: "role.updated",
    target_role_slug: slug,
    details: { before: before ?? null, changes: update },
  });
  return NextResponse.json({ success: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { slug } = await params;
  const admin = createAdminClient();

  // System-Rollen sind nicht loeschbar.
  const { data: role } = await admin.from("roles").select("is_system").eq("slug", slug).single();
  if (role?.is_system) {
    return NextResponse.json({ success: false, error: "System-Rolle kann nicht gelöscht werden" }, { status: 403 });
  }

  // User-Check: wenn noch User auf der Rolle haengen, abbrechen.
  const { count } = await admin.from("profiles").select("*", { count: "exact", head: true }).eq("role", slug);
  if ((count ?? 0) > 0) {
    return NextResponse.json({
      success: false,
      error: `${count} Benutzer haben diese Rolle. Bitte erst zu einer anderen Rolle umziehen.`,
    }, { status: 400 });
  }

  const { data: before } = await admin
    .from("roles")
    .select("label, permissions")
    .eq("slug", slug)
    .maybeSingle();
  const { error } = await admin.from("roles").delete().eq("slug", slug);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  // §9-Rollen-Cache sofort invalidieren (me/dashboard lesen via cachedRoles()).
  revalidateTag(ROLES_TAG, { expire: 0 });

  await logPermissionAudit({
    actor_profile_id: auth.user.id,
    action: "role.deleted",
    target_role_slug: slug,
    details: { before: before ?? null },
  });
  return NextResponse.json({ success: true });
}
