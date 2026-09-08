// /api/me — liefert das Profile + die Permissions fuer die Client-Session.
//
// Der Client-Hook usePermissions() ruft diesen Endpoint statt direkt gegen
// Supabase zu queryen, damit die Server-seitige Impersonation (Developer-
// Mode View-As) sauber durchschlaegt: requireUser() liefert
// effectiveUserId, und wir laden das PROFILE + die ROLLE fuer diese
// effective id (nicht fuer den echten Session-User). Ohne Impersonation ist
// effectiveUserId = user.id, das Verhalten bleibt identisch.
//
// Nutzt createAdminClient() weil bei aktiver Impersonation der effective
// User != Session-User ist und RLS auf profiles/roles sonst die Zeile
// verstecken wuerde (RLS sieht immer den ECHTEN eingeloggten User).
//
// Antwort:
//   { profile: Profile | null, permissions: string[], role: string,
//     is_impersonating: boolean }

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const admin = createAdminClient();

  // dev-mode: effective user — Profile wird fuer die effective id geladen,
  // damit die Client-UI bei aktiver Impersonation die Perspektive des
  // Ziel-Users zeigt (Rolle, Name, Rechte).
  //
  // profiles + roles laufen PARALLEL statt sequentiell: profiles.role ist
  // bewusst ein text-Feld ohne FK auf roles (048_roles.sql), ein PostgREST-
  // Embed-Join geht daher nicht. Stattdessen holen wir alle Rollen (eine
  // Handvoll Zeilen) gleichzeitig und matchen lokal — spart einen vollen
  // DB-Roundtrip auf dem kritischsten Pfad (App-Boot wartet auf /api/me).
  const [profileRes, rolesRes] = await Promise.all([
    admin
      .from("profiles")
      .select("*")
      .eq("id", auth.effectiveUserId)
      .maybeSingle(),
    admin.from("roles").select("slug, permissions"),
  ]);
  const { data: profile, error: profErr } = profileRes;

  if (profErr) {
    return NextResponse.json(
      { success: false, error: `Profil-Laden fehlgeschlagen: ${profErr.message}` },
      { status: 500 },
    );
  }
  if (!profile) {
    return NextResponse.json(
      {
        profile: null,
        permissions: [],
        role: "",
        is_impersonating: auth.isImpersonating,
      },
      { status: 200 },
    );
  }

  const role = (profile.role as string | null) ?? "";
  let permissions: string[] = [];
  if (role) {
    // Tolerant wie vorher: Fehler beim roles-Laden oder geloeschte/fehlende
    // Rolle → leere Permissions, das Profil wird trotzdem geliefert.
    const roleRows = (rolesRes.data ?? []) as unknown as Array<{
      slug: string;
      permissions: unknown;
    }>;
    const roleRow = roleRows.find((r) => r.slug === role);
    if (Array.isArray(roleRow?.permissions)) {
      permissions = roleRow.permissions as string[];
    }
  }

  return NextResponse.json({
    profile,
    permissions,
    role,
    is_impersonating: auth.isImpersonating,
  });
}
