// PATCH /api/admin/roles/[slug] — Label oder Permissions aendern.
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
import { DASHBOARD_WIDGETS } from "@/lib/dashboard-widgets";

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
  // dashboard_widgets: {order: string[], hidden: string[]} oder null (=Reset).
  // Unbekannte Widget-IDs werden STILL gedroppt (siehe user-override-Route),
  // damit ein alter Admin-Client nach Registry-Umbau nicht plötzlich 400t.
  if (Object.prototype.hasOwnProperty.call(body, "dashboard_widgets")) {
    const dw = (body as { dashboard_widgets: unknown }).dashboard_widgets;
    if (dw === null) {
      update.dashboard_widgets = null;
    } else if (dw && typeof dw === "object" && !Array.isArray(dw)) {
      const known = new Set<string>(DASHBOARD_WIDGETS.map((w) => w.id));
      const obj = dw as { order?: unknown; hidden?: unknown };
      const order = Array.isArray(obj.order)
        ? (obj.order as unknown[]).filter((s): s is string => typeof s === "string" && known.has(s))
        : [];
      const hidden = Array.isArray(obj.hidden)
        ? (obj.hidden as unknown[]).filter((s): s is string => typeof s === "string" && known.has(s))
        : [];
      update.dashboard_widgets = { order, hidden };
    } else {
      return NextResponse.json({ success: false, error: "dashboard_widgets ungültig" }, { status: 400 });
    }
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: false, error: "Keine Änderungen" }, { status: 400 });
  }

  const admin = createAdminClient();
  // Vorher-Zustand fuer Audit-Diff laden.
  const { data: before } = await admin
    .from("roles")
    .select("label, permissions, dashboard_widgets, scope")
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
