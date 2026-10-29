import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeJobPlannedCosts } from "./job-costs";

// Regression Zeitzonen-Waechter: der Lohn eines Termins gilt am ZUERICH-Tag
// von start_time (timestamptz), nicht am UTC-Tag. Frueher pickte
// start_time.slice(0, 10) zwischen 00:00 und 02:00 Zuerich den Vortag —
// am Tag einer Lohnerhoehung also den alten Lohn.

/** Minimaler Supabase-Ersatz: jede Kette liefert die Fixture-Zeilen der Tabelle. */
function fakeAdmin(tables: Record<string, unknown[]>): SupabaseClient {
  const builder = (table: string): unknown => {
    const rows = tables[table] ?? [];
    const result = { data: rows, error: null };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
          if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: rows[0] ?? null, error: null });
          return () => proxy;
        },
      },
    );
    return proxy;
  };
  return { from: builder } as unknown as SupabaseClient;
}

/** Lohn-Zeile mit eigenen Sätzen 0 % → Vollkosten = Brutto (Rechnung bleibt lesbar).
 *  Sätze ausdrücklich gesetzt: fehlende Sätze sind seit Phase 2 ein Fehler. */
function comp(effective_from: string, effective_to: string | null, hourly_wage_chf: number) {
  return { profile_id: "u1", hourly_wage_chf, uses_standard_lohn: false, effective_from, effective_to, ahv_iv_eo_pct: 0, alv_pct: 0, nbu_pct: 0, bvg_pct: 0, ktg_pct: 0, quellensteuer_pct: 0, employer_ahv_pct: 0, employer_alv_pct: 0, employer_fak_pct: 0, employer_bu_pct: 0, employer_bvg_pct: 0, employer_verwaltung_pct: 0 };
}

/** Lohnerhoehung 30 → 40 CHF/h ab `wechsel` (YYYY-MM-DD). */
function lohnWechsel(vortag: string, wechsel: string) {
  return [comp("2026-01-01", vortag, 30), comp(wechsel, null, 40)];
}

async function kosten(startUtc: string, endUtc: string, comps: unknown[]) {
  const admin = fakeAdmin({
    job_appointments: [{ job_id: "j1", start_time: startUtc, end_time: endUtc, assigned_to: "u1" }],
    employee_compensation: comps,
    payroll_defaults: [{ effective_from: "2026-01-01", default_ahv_iv_eo_pct: 5.3, default_alv_pct: 1.1, default_nbu_pct: 1.45, default_bvg_pct: 0, default_ktg_pct: 0, default_quellensteuer_pct: 0, default_employer_ahv_pct: 5.3, default_employer_alv_pct: 1.1, default_employer_fak_pct: 1.35, default_employer_bu_pct: 0.5742, default_employer_bvg_pct: 0, default_employer_verwaltung_pct: 0.11, bvg_threshold_chf: 1890 }],
  });
  return (await computeJobPlannedCosts(admin, ["j1"])).get("j1");
}

describe("computeJobPlannedCosts — Lohn am Zuerich-Tag", () => {
  it("00:30 Zuerich (2026-10-11T22:30Z) rechnet mit dem Lohn vom 12.10.", async () => {
    const r = await kosten("2026-10-11T22:30:00+00:00", "2026-10-12T00:30:00+00:00", lohnWechsel("2026-10-11", "2026-10-12"));
    expect(r?.minutes).toBe(120);
    expect(r?.vollkosten_chf).toBeCloseTo(80); // 2 h × 40, nicht × 30
  });

  it("23:30 Zuerich bleibt am selben Tag (alter Lohn)", async () => {
    const r = await kosten("2026-10-11T21:30:00+00:00", "2026-10-11T22:30:00+00:00", lohnWechsel("2026-10-11", "2026-10-12"));
    expect(r?.vollkosten_chf).toBeCloseTo(30);
  });

  it("Sommerzeit-Beginn: 29.03.2026 00:30 MEZ (2026-03-28T23:30Z)", async () => {
    const r = await kosten("2026-03-28T23:30:00+00:00", "2026-03-29T00:30:00+00:00", lohnWechsel("2026-03-28", "2026-03-29"));
    expect(r?.vollkosten_chf).toBeCloseTo(40);
  });

  it("Sommerzeit-Ende: 25.10.2026 00:30 MESZ (2026-10-24T22:30Z)", async () => {
    const r = await kosten("2026-10-24T22:30:00+00:00", "2026-10-24T23:30:00+00:00", lohnWechsel("2026-10-24", "2026-10-25"));
    expect(r?.vollkosten_chf).toBeCloseTo(40);
  });
});
