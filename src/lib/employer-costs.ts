/**
 * Effektive Arbeitgeber-Kosten pro Stunde: Override oder firmenweiter
 * Standard. Wird seit Migration 152 ueberall gebraucht wo der reine
 * Spalten-Wert NICHT mehr ausreicht (kann jetzt null sein).
 *
 * Regel: pro-Mitarbeiter-Override gewinnt. Wenn der Override null oder
 * undefined ist, fallback auf den globalen Standard aus app_settings
 * (default_employer_costs_chf_per_hour).
 */
export function resolveEmployerCosts(
  override: number | null | undefined,
  defaultPerHour: number,
): number {
  if (override == null) return defaultPerHour;
  return Number(override);
}

/** Convenience: lade den firmenweiten Default aus app_settings. */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function loadDefaultEmployerCosts(client: SupabaseClient): Promise<number> {
  const { data } = await client
    .from("app_settings")
    .select("default_employer_costs_chf_per_hour")
    .eq("id", 1)
    .maybeSingle();
  return Number(data?.default_employer_costs_chf_per_hour ?? 0);
}
