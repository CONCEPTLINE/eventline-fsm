// Personal-Vollkosten pro Auftrag — Batch-Berechnung fuer die Admin-
// Kostenvorschau in der Auftraege-Liste.
//
// Gleiche Semantik wie src/lib/location-report.ts (dort Kommentar-
// Querverweis): Stunden aus time_entries UND service_reports.time_ranges
// (Pausen abgezogen), Kosten = Brutto-Stundenlohn zum Stempel-Datum ×
// (1 + Summe Arbeitgeber-Anteil %). Lohn-Historie via effective_from/to,
// AG-Anteile via employee_compensation-Overrides bzw. payroll_defaults.
//
// Aenderungen an dieser Formel IMMER auch in location-report.ts pruefen
// (und umgekehrt) — die Kostenvorschau und der Standort-Rapport muessen
// fuer denselben Auftrag dieselbe Zahl zeigen.

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

interface RawEntry {
  clock_in: string;
  clock_out: string | null;
  user_id: string;
  job_id: string | null;
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

/**
 * Vollkosten fuer eine Menge Auftraege. Gibt nur Jobs zurueck, die
 * ueberhaupt Zeit haben (Map-Miss = 0 Minuten / CHF 0).
 */
export async function computeJobPersonnelCosts(
  admin: SupabaseClient,
  jobIds: string[],
): Promise<Map<string, JobCost>> {
  const result = new Map<string, JobCost>();
  if (jobIds.length === 0) return result;

  const [teRes, srRes, lohnDefaults] = await Promise.all([
    admin
      .from("time_entries")
      .select("clock_in, clock_out, user_id, job_id")
      .in("job_id", jobIds),
    admin
      .from("service_reports")
      .select("job_id, created_by, time_ranges")
      .in("job_id", jobIds),
    loadLohnDefaults(admin),
  ]);
  if (teRes.error) throw new Error(teRes.error.message);
  if (srRes.error) throw new Error(srRes.error.message);

  const entries: RawEntry[] = [...((teRes.data ?? []) as RawEntry[])];

  // Rapport-Zeiten als synthetische Eintraege (Pause via clock_out-Reduktion).
  for (const sr of (srRes.data ?? []) as { job_id: string; created_by: string; time_ranges: unknown }[]) {
    if (!Array.isArray(sr.time_ranges)) continue;
    for (const range of sr.time_ranges as { date?: string; start?: string; end?: string; pause?: number }[]) {
      if (!range.date || !range.start || !range.end) continue;
      const clockOut = `${range.date}T${range.end}:00`;
      const pauseMin = Math.max(0, Number(range.pause ?? 0));
      const outMs = new Date(clockOut).getTime() - pauseMin * 60_000;
      if (Number.isNaN(outMs)) continue;
      entries.push({
        clock_in: `${range.date}T${range.start}:00`,
        clock_out: new Date(outMs).toISOString(),
        user_id: sr.created_by,
        job_id: sr.job_id,
      });
    }
  }

  const userIds = Array.from(new Set(entries.map((e) => e.user_id)));
  let comps: RawComp[] = [];
  if (userIds.length > 0) {
    const { data, error } = await admin
      .from("employee_compensation")
      .select("profile_id, hourly_wage_chf, uses_standard_lohn, effective_from, effective_to, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct")
      .in("profile_id", userIds);
    if (error) throw new Error(error.message);
    comps = (data ?? []) as RawComp[];
  }

  for (const e of entries) {
    if (!e.job_id) continue;
    const mins = minutesBetween(e.clock_in, e.clock_out);
    if (mins <= 0) continue;
    const cur = result.get(e.job_id) ?? { minutes: 0, vollkosten_chf: 0 };
    cur.minutes += mins;
    const comp = pickCompForDate(comps, e.user_id, e.clock_in.slice(0, 10));
    const brutto = Number(comp?.hourly_wage_chf ?? 0);
    if (brutto > 0) {
      const pctSet: LohnPctSet = effectivePcts(comp as PctComp, lohnDefaults);
      const hourlyVoll = brutto * (1 + sumEmployerPct(pctSet) / 100);
      cur.vollkosten_chf += (hourlyVoll * mins) / 60;
    }
    result.set(e.job_id, cur);
  }

  return result;
}
