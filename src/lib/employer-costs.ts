/**
 * Lohn-Defaults und effektive Werte pro Mitarbeiter.
 *
 * Schema seit Migration 195:
 *   - Firmen-Defaults leben in payroll_defaults (Multi-Row mit
 *     effective_from-Historie). loadLohnDefaults(client, asOf?) liefert
 *     die zum Datum gueltige Zeile (neueste mit effective_from <= asOf).
 *     Ohne asOf: heute. Wichtig fuer Regenerate alter Lohnabrechnungen:
 *     Aufrufer muss den ABRECHNUNGS-Monatsanfang uebergeben, nicht heute.
 *   - employee_compensation.uses_standard_lohn=true => alle Per-Spalten
 *     werden ignoriert, der Firmen-Standard greift komplett (all-or-
 *     nothing). uses_standard_lohn=false => die 12 expliziten Spalten
 *     zaehlen (NULL fallback auf 0 — UI sollte die nicht NULL lassen).
 *
 * AG-Anteil pro Stunde = Brutto * (Summe der 6 AG-Pcts) / 100.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { todayLocalIso } from "@/lib/swiss-time";

export interface LohnPctSet {
  // Mitarbeiter-Abzuege (% vom Brutto)
  ahvIvEoPct: number;
  alvPct: number;
  nbuPct: number;
  bvgPct: number;
  ktgPct: number;
  quellensteuerPct: number;
  // Arbeitgeber-Anteil (% vom Brutto)
  employerAhvPct: number;
  employerAlvPct: number;
  employerFakPct: number;
  employerBuPct: number;
  employerBvgPct: number;
  employerVerwaltungPct: number;
}

const FALLBACK: LohnPctSet = {
  ahvIvEoPct: 5.3,
  alvPct: 1.1,
  nbuPct: 1.4,
  bvgPct: 0,
  ktgPct: 0,
  quellensteuerPct: 0,
  employerAhvPct: 5.3,
  employerAlvPct: 1.1,
  employerFakPct: 1.5,
  employerBuPct: 0.5,
  employerBvgPct: 3.0,
  employerVerwaltungPct: 0.5,
};

/** Summe der 6 AG-Pcts (= Arbeitgeber-Anteil als % vom Brutto). */
export function sumEmployerPct(s: LohnPctSet): number {
  return s.employerAhvPct + s.employerAlvPct + s.employerFakPct
       + s.employerBuPct + s.employerBvgPct + s.employerVerwaltungPct;
}

/** Summe der 6 AN-Pcts (= Mitarbeiter-Abzuege als % vom Brutto). */
export function sumEmployeePct(s: LohnPctSet): number {
  return s.ahvIvEoPct + s.alvPct + s.nbuPct + s.bvgPct + s.ktgPct + s.quellensteuerPct;
}

/** AG-Anteil pro Stunde in CHF. */
export function employerCostsPerHour(brutto: number, agPctSum: number): number {
  return (brutto * agPctSum) / 100;
}

/** Liefert die effektiven Pcts fuer eine Compensation-Row. Bei
 *  uses_standard_lohn (oder fehlender Row): Firmen-Standard. Sonst die
 *  expliziten Spalten-Werte (NULL -> 0). */
export function effectivePcts(
  comp: PctComp | null | undefined,
  defaults: LohnPctSet,
): LohnPctSet {
  if (!comp || comp.uses_standard_lohn !== false) return defaults;
  const n = (v: unknown): number => v == null ? 0 : Number(v);
  return {
    ahvIvEoPct: n(comp.ahv_iv_eo_pct),
    alvPct: n(comp.alv_pct),
    nbuPct: n(comp.nbu_pct),
    bvgPct: n(comp.bvg_pct),
    ktgPct: n(comp.ktg_pct),
    quellensteuerPct: n(comp.quellensteuer_pct),
    employerAhvPct: n(comp.employer_ahv_pct),
    employerAlvPct: n(comp.employer_alv_pct),
    employerFakPct: n(comp.employer_fak_pct),
    employerBuPct: n(comp.employer_bu_pct),
    employerBvgPct: n(comp.employer_bvg_pct),
    employerVerwaltungPct: n(comp.employer_verwaltung_pct),
  };
}

/** Minimaler Row-Shape den effectivePcts braucht. */
export interface PctComp {
  uses_standard_lohn?: boolean | null;
  ahv_iv_eo_pct?: number | string | null;
  alv_pct?: number | string | null;
  nbu_pct?: number | string | null;
  bvg_pct?: number | string | null;
  ktg_pct?: number | string | null;
  quellensteuer_pct?: number | string | null;
  employer_ahv_pct?: number | string | null;
  employer_alv_pct?: number | string | null;
  employer_fak_pct?: number | string | null;
  employer_bu_pct?: number | string | null;
  employer_bvg_pct?: number | string | null;
  employer_verwaltung_pct?: number | string | null;
}

/** Laedt die zum Datum gueltigen Firmen-Defaults. Ohne asOf: heute
 *  (nur fuer Vorschau/Sanity-Checks OK — fuer Lohnabrechnungen IMMER
 *  den Monatsanfang uebergeben, sonst wird retroaktiv mit dem heute
 *  gueltigen Satz gerechnet).
 *
 *  Liest aus payroll_defaults (Multi-Row-Historie, Migration 195).
 *  Fallback wenn kein Datensatz existiert: kanonische Schweiz-Defaults
 *  aus FALLBACK. */
export async function loadLohnDefaults(client: SupabaseClient, asOf?: string): Promise<LohnPctSet> {
  const asOfDate = asOf ?? todayLocalIso();
  const { data } = await client
    .from("payroll_defaults")
    .select("default_ahv_iv_eo_pct, default_alv_pct, default_nbu_pct, default_bvg_pct, default_ktg_pct, default_quellensteuer_pct, default_employer_ahv_pct, default_employer_alv_pct, default_employer_fak_pct, default_employer_bu_pct, default_employer_bvg_pct, default_employer_verwaltung_pct")
    .lte("effective_from", asOfDate)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    ahvIvEoPct: Number(data?.default_ahv_iv_eo_pct ?? FALLBACK.ahvIvEoPct),
    alvPct: Number(data?.default_alv_pct ?? FALLBACK.alvPct),
    nbuPct: Number(data?.default_nbu_pct ?? FALLBACK.nbuPct),
    bvgPct: Number(data?.default_bvg_pct ?? FALLBACK.bvgPct),
    ktgPct: Number(data?.default_ktg_pct ?? FALLBACK.ktgPct),
    quellensteuerPct: Number(data?.default_quellensteuer_pct ?? FALLBACK.quellensteuerPct),
    employerAhvPct: Number(data?.default_employer_ahv_pct ?? FALLBACK.employerAhvPct),
    employerAlvPct: Number(data?.default_employer_alv_pct ?? FALLBACK.employerAlvPct),
    employerFakPct: Number(data?.default_employer_fak_pct ?? FALLBACK.employerFakPct),
    employerBuPct: Number(data?.default_employer_bu_pct ?? FALLBACK.employerBuPct),
    employerBvgPct: Number(data?.default_employer_bvg_pct ?? FALLBACK.employerBvgPct),
    employerVerwaltungPct: Number(data?.default_employer_verwaltung_pct ?? FALLBACK.employerVerwaltungPct),
  };
}

/** Laedt die BVG-Eintrittsschwelle (CHF/Monat) fuer das gegebene Datum.
 *  Ohne asOf: heute. Analog loadLohnDefaults — historisierbar seit
 *  Migration 195. */
export async function loadBvgThreshold(client: SupabaseClient, asOf?: string): Promise<number> {
  const asOfDate = asOf ?? todayLocalIso();
  const { data } = await client
    .from("payroll_defaults")
    .select("bvg_threshold_chf")
    .lte("effective_from", asOfDate)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  return Number(data?.bvg_threshold_chf ?? 1837.50);
}
