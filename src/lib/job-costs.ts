// Personal-Kosten-PROGNOSE pro Auftrag — fuer die Admin-Badge im
// Termine-Header (PlannedCostBadge): geplante Termine × Voll-CHF/h.
//
// Vollkosten-Formel wie in src/lib/location-report.ts (dort Kommentar-
// Querverweis): Brutto-Stundenlohn zum jeweiligen Datum × (1 + Summe
// Arbeitgeber-Anteil %). Lohn-Historie via effective_from/to, AG-Anteile
// via employee_compensation-Overrides bzw. payroll_defaults.
//
// Aenderungen an dieser Formel IMMER auch in location-report.ts pruefen
// (und umgekehrt) — Prognose und Standort-Rapport muessen dieselbe
// Kosten-Basis nutzen.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  effectivePcts,
  loadLohnDefaults,
  sumEmployerPct,
  type LohnPctSet,
  type PctComp,
} from "@/lib/employer-costs";

export interface JobCost {
  minutes: number;
  vollkosten_chf: number;
}

/**
 * PROGNOSE-Kosten aus geplanten Terminen: pro job_appointment (eine Row
 * je zugewiesener Person) Dauer × Voll-CHF/h der Person zum Termin-Datum.
 * Zukuenftige Termine rechnen dank Lohn-Historie automatisch mit einer
 * bereits GEPLANTEN Lohnerhoehung (effective_from in der Zukunft).
 * Termine ohne Zuweisung fliessen nicht ein (weder Stunden noch Kosten).
 */
export async function computeJobPlannedCosts(
  admin: SupabaseClient,
  jobIds: string[],
): Promise<Map<string, JobCost>> {
  const result = new Map<string, JobCost>();
  if (jobIds.length === 0) return result;

  const [apptRes, lohnDefaults] = await Promise.all([
    admin
      .from("job_appointments")
      .select("job_id, start_time, end_time, assigned_to")
      .in("job_id", jobIds)
      .not("assigned_to", "is", null),
    loadLohnDefaults(admin),
  ]);
  if (apptRes.error) throw new Error(apptRes.error.message);
  const appts = (apptRes.data ?? []) as { job_id: string; start_time: string; end_time: string; assigned_to: string }[];

  const userIds = Array.from(new Set(appts.map((a) => a.assigned_to)));
  let comps: RawComp[] = [];
  if (userIds.length > 0) {
    const { data, error } = await admin
      .from("employee_compensation")
      .select("profile_id, hourly_wage_chf, uses_standard_lohn, effective_from, effective_to, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct")
      .in("profile_id", userIds);
    if (error) throw new Error(error.message);
    comps = (data ?? []) as RawComp[];
  }

  for (const a of appts) {
    const mins = minutesBetween(a.start_time, a.end_time);
    if (mins <= 0) continue;
    const cur = result.get(a.job_id) ?? { minutes: 0, vollkosten_chf: 0 };
    cur.minutes += mins;
    const comp = pickCompForDate(comps, a.assigned_to, a.start_time.slice(0, 10));
    const brutto = Number(comp?.hourly_wage_chf ?? 0);
    if (brutto > 0) {
      const pctSet: LohnPctSet = effectivePcts(comp as PctComp, lohnDefaults);
      const hourlyVoll = brutto * (1 + sumEmployerPct(pctSet) / 100);
      cur.vollkosten_chf += (hourlyVoll * mins) / 60;
    }
    result.set(a.job_id, cur);
  }

  return result;
}

interface RawComp {
  profile_id: string;
  hourly_wage_chf: number | null;
  uses_standard_lohn: boolean | null;
  effective_from: string | null;
  effective_to: string | null;
  ahv_iv_eo_pct: number | null;
  alv_pct: number | null;
  nbu_pct: number | null;
  bvg_pct: number | null;
  ktg_pct: number | null;
  quellensteuer_pct: number | null;
  employer_ahv_pct: number | null;
  employer_alv_pct: number | null;
  employer_fak_pct: number | null;
  employer_bu_pct: number | null;
  employer_bvg_pct: number | null;
  employer_verwaltung_pct: number | null;
}

function minutesBetween(from: string, to: string | null): number {
  const end = to ?? new Date().toISOString();
  const ms = new Date(end).getTime() - new Date(from).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

/** Comp-Row die zum Datum galt; Fallback: juengste davor, sonst irgendeine. */
function pickCompForDate(rows: RawComp[], userId: string, dateIso: string): RawComp | null {
  const forUser = rows.filter((r) => r.profile_id === userId);
  if (forUser.length === 0) return null;
  const match = forUser.find((r) => {
    if (!r.effective_from) return false;
    if (r.effective_from > dateIso) return false;
    if (r.effective_to && r.effective_to < dateIso) return false;
    return true;
  });
  if (match) return match;
  const past = forUser
    .filter((r) => r.effective_from && r.effective_from <= dateIso)
    .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""));
  return past[0] ?? forUser[0] ?? null;
}

// (computeJobPersonnelCosts — Ist-Kosten pro Auftrag — wurde 2026-09-08
// wieder entfernt: Leo will nur die Termin-Prognose; Ist-Zahlen liefert
// der Standort-Rapport via location-report.ts.)
