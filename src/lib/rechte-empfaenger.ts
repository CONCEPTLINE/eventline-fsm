// Wer hat ein Recht? — aktive, interne Konten, deren Rolle den Slug traegt.
// Admins haben immer alles (CLAUDE.md §5, gleiche Regel wie has_permission()
// in der DB und hasPermission() im Client). Nie eine feste Namensliste.
//
// Server-seitig mit dem Admin-Client (Rollen + Profile aller Personen).

import type { SupabaseClient } from "@supabase/supabase-js";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";

export interface PersonMitRecht {
  id: string;
  full_name: string;
}

export async function personenMitRecht(admin: SupabaseClient, recht: string): Promise<PersonMitRecht[]> {
  const { data: rollen, error: rErr } = await admin.from("roles").select("slug, permissions");
  if (rErr) throw new Error(`Rollen konnten nicht geladen werden: ${rErr.message}`);
  const slugs = ((rollen ?? []) as { slug: string; permissions: unknown }[])
    .filter((r) => r.slug === "admin" || (Array.isArray(r.permissions) && (r.permissions as string[]).includes(recht)))
    .map((r) => r.slug);
  if (slugs.length === 0) return [];
  const { data, error } = await admin
    .from("profiles")
    .select("id, full_name")
    .in("role", slugs)
    .eq("is_active", true)
    .not("role", "in", PORTAL_ROLLEN_IN)
    .order("full_name");
  if (error) throw new Error(`Personen konnten nicht geladen werden: ${error.message}`);
  return (data ?? []) as PersonMitRecht[];
}
