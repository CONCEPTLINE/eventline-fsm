/**
 * Effektive Lohn-Standards: Override (per Mitarbeiter) ODER firmenweiter
 * Standard. Alle Werte sind Prozente, der Arbeitgeber-Anteil pro Stunde
 * wird aus pct + brutto-Lohn berechnet.
 *
 * Regel ueberall: pro-Mitarbeiter-Override gewinnt. NULL = Default aus
 * app_settings (Migrationen 152-154).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface LohnDefaults {
  /** Arbeitgeber-Anteil als % vom Brutto (z.B. 12 = 12%). Deckt
   *  AHV-AG-Mirror + ALV-AG + FAK + BU + BVG-AG + Verwaltung. */
  employerPct: number;
  ahvIvEoPct: number;
  alvPct: number;
  nbuPct: number;
  bvgPct: number;
  ktgPct: number;
  quellensteuerPct: number;
}

const FALLBACK: LohnDefaults = {
  employerPct: 12,
  ahvIvEoPct: 5.3,
  alvPct: 1.1,
  nbuPct: 1.4,
  bvgPct: 0,
  ktgPct: 0,
  quellensteuerPct: 0,
};

/** Generischer Resolver: Override oder Fallback. */
export function resolvePct(
  override: number | null | undefined,
  fallback: number,
): number {
  if (override == null) return fallback;
  return Number(override);
}

/** AG-Anteil pro Stunde aus pct + brutto. */
export function employerCostsPerHour(brutto: number, pct: number): number {
  return (brutto * pct) / 100;
}

/** Laedt alle Standardwerte in einem Query. */
export async function loadLohnDefaults(client: SupabaseClient): Promise<LohnDefaults> {
  const { data } = await client
    .from("app_settings")
    .select(
      "default_employer_pct, default_ahv_iv_eo_pct, default_alv_pct, default_nbu_pct, default_bvg_pct, default_ktg_pct, default_quellensteuer_pct",
    )
    .eq("id", 1)
    .maybeSingle();
  return {
    employerPct: Number(data?.default_employer_pct ?? FALLBACK.employerPct),
    ahvIvEoPct: Number(data?.default_ahv_iv_eo_pct ?? FALLBACK.ahvIvEoPct),
    alvPct: Number(data?.default_alv_pct ?? FALLBACK.alvPct),
    nbuPct: Number(data?.default_nbu_pct ?? FALLBACK.nbuPct),
    bvgPct: Number(data?.default_bvg_pct ?? FALLBACK.bvgPct),
    ktgPct: Number(data?.default_ktg_pct ?? FALLBACK.ktgPct),
    quellensteuerPct: Number(data?.default_quellensteuer_pct ?? FALLBACK.quellensteuerPct),
  };
}
