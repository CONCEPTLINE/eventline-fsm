// Zentrale Rollen-Taxonomie — DIE eine Stelle, die definiert, welche
// Rollen Portal-Zugaenge sind (= KEINE firmeninternen Mitarbeiter).
//
// Hintergrund (2026-09-23): ".neq('role','partner')" war an ~20 Stellen
// hart kopiert; als die Lieferanten-Rolle dazukam, rutschten Lieferanten
// ueberall in interne Mitarbeiter-Dropdowns, Lohnlisten usw. Damit das
// bei der NAECHSTEN Portal-Rolle (z.B. 'kunde') nicht wieder passiert:
// neue Portal-Rolle HIER eintragen — alle Filter ziehen automatisch mit.
//
// SQL-Seite: Policies nutzen is_partner()/is_lieferant() — bei einer
// neuen Portal-Rolle auch dort eine Funktion ergaenzen (siehe
// supabase/migrations/234_lieferantenportal_grundstruktur.sql).

export const PORTAL_ROLLEN = ["partner", "lieferant"] as const;

/** true = firmeninterner Mitarbeiter (keine Portal-Rolle). */
export function istIntern(role: string | null | undefined): boolean {
  return !!role && !(PORTAL_ROLLEN as readonly string[]).includes(role);
}

/** PostgREST-Filterwert fuer Supabase-Queries auf profiles:
 *  `.not("role", "in", PORTAL_ROLLEN_IN)` — nur interne Mitarbeiter. */
export const PORTAL_ROLLEN_IN = `(${PORTAL_ROLLEN.join(",")})`;
