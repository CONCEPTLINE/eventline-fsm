// GET /api/admin/roles — alle Rollen.
// POST /api/admin/roles — neue Rolle anlegen.

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLES_TAG } from "@/lib/cached";
import { requireAdmin } from "@/lib/api-auth";
import { allKnownPermissions } from "@/lib/permissions";
import { logPermissionAudit } from "@/lib/permission-audit";

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data, error } = await admin.from("roles").select("*").order("is_system", { ascending: false }).order("label");
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, roles: data });
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungültiger Body" }, { status: 400 });

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ success: false, error: "Label ist Pflicht" }, { status: 400 });

  // Slug aus Label generieren — lowercase, ascii, dashes.
  const slug = label
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    return NextResponse.json({ success: false, error: "Ungültiger Name" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Reservierte Slugs kommen aus der DB (roles.is_system=true) statt hart
  // codiert — 'techniker' war z.B. mal System und ist es nicht mehr, das
  // wurde in der alten Hardcode-Liste nie nachgezogen. Zusaetzlich schuetzt
  // der 23505-Handler unten gegen Duplikate ueber alle Rollen (auch non-
  // system).
  const { data: systemRoles } = await admin.from("roles").select("slug").eq("is_system", true);
  const reserved = new Set(((systemRoles ?? []) as Array<{ slug: string }>).map((r) => r.slug));
  if (reserved.has(slug)) {
    return NextResponse.json({ success: false, error: "Reservierter Name (System-Rolle)" }, { status: 400 });
  }

  // Permissions validieren — nur bekannte module:action-Strings erlaubt.
  const valid = new Set(allKnownPermissions());
  const permissions = Array.isArray(body.permissions)
    ? (body.permissions as unknown[]).filter((s): s is string => typeof s === "string" && valid.has(s))
    : [];

  // scope: Zugriffs-Reichweite. Default = 'self' (DB-Default aus Migration 208).
  // Wenn explizit gesetzt, validieren; sonst DB-Default nutzen.
  let scope: "self" | "team" | "all" | undefined;
  if (typeof body.scope === "string") {
    if (body.scope !== "self" && body.scope !== "team" && body.scope !== "all") {
      return NextResponse.json({ success: false, error: "scope ungültig (self/team/all)" }, { status: 400 });
    }
    scope = body.scope;
  }
  const { error } = await admin.from("roles").insert({
    slug,
    label,
    permissions,
    is_system: false,
    ...(scope ? { scope } : {}),
  });
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ success: false, error: "Eine Rolle mit diesem Namen existiert bereits" }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  // §9-Rollen-Cache sofort invalidieren (me/dashboard lesen via cachedRoles()).
  revalidateTag(ROLES_TAG, { expire: 0 });

  await logPermissionAudit({
    actor_profile_id: auth.user.id,
    action: "role.created",
    target_role_slug: slug,
    details: { label, permissions, scope: scope ?? "self" },
  });
  return NextResponse.json({ success: true, slug });
}
