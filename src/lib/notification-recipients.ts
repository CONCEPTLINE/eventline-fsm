// Empfaenger-Ermittlung fuer Benachrichtigungen: alle aktiven internen
// Profile, deren Rolle eine Permission hat (Admin-Rolle immer).
// Extrahiert aus api/tickets/notify (dem bisher einzigen Ort, der es
// richtig machte) — Skalierbarkeits-Audit 2026-09-23: mehrere Routen
// schickten stattdessen stur an role='admin', womit Rollen wie
// "Buchhaltung" nie etwas erfuhren.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function recipientsWithPermission(
  admin: SupabaseClient,
  permission: string,
  opts?: { exclude?: (string | null | undefined)[] },
): Promise<string[]> {
  const { data: rolesRes } = await admin.from("roles").select("slug, permissions, is_portal");
  const slugs = ((rolesRes ?? []) as { slug: string; permissions: unknown; is_portal: boolean | null }[])
    // Portal-Rollen (partner/lieferant) NIE in interne Verteiler — auch
    // dann nicht, wenn ihnen mal eine interne Permission zugewiesen wird.
    .filter((r) => !r.is_portal)
    .filter((r) => r.slug === "admin" || (Array.isArray(r.permissions) && (r.permissions as string[]).includes(permission)))
    .map((r) => r.slug);
  if (slugs.length === 0) return [];
  const { data } = await admin.from("profiles").select("id").in("role", slugs).eq("is_active", true);
  const exclude = new Set((opts?.exclude ?? []).filter(Boolean) as string[]);
  return ((data ?? []) as { id: string }[]).map((p) => p.id).filter((id) => !exclude.has(id));
}
