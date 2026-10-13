// Steuerung des Rigs (VERTRAG §2.5): gewuenschtes Luefter-Profil aus technik_steuerung (Migration 318).
// Lesen fuer die Seite (GET /api/technik/stand) und fuer die Antwort an das Rig (POST /api/technik/messwerte),
// Setzen ueber POST /api/technik/steuerung. Nur serverseitig mit dem Admin-Client (service_role).

import type { SupabaseClient } from "@supabase/supabase-js";
import { LUEFTER_PROFIL_STANDARD, LUEFTER_PROFILE } from "./konstanten";
import type { LuefterProfil, SteuerungRig, SteuerungStand } from "./typen";

export const istLuefterProfil = (x: unknown): x is LuefterProfil =>
  typeof x === "string" && (LUEFTER_PROFILE as readonly string[]).includes(x);

/** Gewuenschtes Profil; fehlt die Zeile, gilt der Standard. Wirft bei Datenbankfehlern. */
export async function ladeSteuerung(admin: SupabaseClient): Promise<SteuerungStand> {
  const { data, error } = await admin.from("technik_steuerung").select("luefter_profil, geaendert_am").eq("id", 1).maybeSingle();
  if (error) throw new Error(`technik_steuerung: ${error.message}`);
  const z = data as { luefter_profil: unknown; geaendert_am: string | null } | null;
  const am = z?.geaendert_am ? Date.parse(z.geaendert_am) : Number.NaN;
  return {
    luefter_profil: istLuefterProfil(z?.luefter_profil) ? z.luefter_profil : LUEFTER_PROFIL_STANDARD,
    geaendert_am: Number.isFinite(am) ? new Date(am).toISOString() : null,
  };
}

/** Block `steuerung` der Antwort an das Rig. Ohne Zeitpunkt (nie gesetzt) gilt der Beginn der Unix-Zeit. */
export function steuerungFuersRig(s: SteuerungStand): SteuerungRig {
  return { luefter_profil: s.luefter_profil, stand: s.geaendert_am ?? new Date(0).toISOString() };
}
