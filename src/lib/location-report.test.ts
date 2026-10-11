import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression Zeitzonen-Waechter: Tier-Preis, Lohn und Monats-Zuordnung eines
// Stempel-Eintrags gelten am ZUERICH-Tag von clock_in (timestamptz). Frueher
// lieferte clock_in.slice(0, 10) zwischen 00:00 und 02:00 Zuerich den Vortag
// (und am Monatsersten den Vormonat). Rapport-Zeiten (naive Lokalzeit mit
// eigenem Datum) behalten ihr Datum.

const tables: Record<string, unknown[]> = {};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
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
    },
  }),
}));

import { loadLocationReport } from "./location-report";

/** Wechsel am Tag `wechsel`: Lohn 30 → 40 CHF/h (ohne AG-Anteile), Preis 100 → 120 CHF/h. */
function setup(vortag: string, wechsel: string, entries: { time?: unknown[]; reports?: unknown[] }) {
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, {
    locations: [{ id: "loc1", name: "Test", customer: null }],
    jobs: [{ id: "j1", job_number: 1, title: "T", status: "abgeschlossen", start_date: "2026-01-05T08:00:00+00:00", end_date: null, invoiced_at: null, customer_id: null, customer: null }],
    time_entries: entries.time ?? [],
    service_reports: entries.reports ?? [],
    location_rate_tiers: [{ id: "t1", location_id: "loc1", key: "std", label: "Standard", is_default: true, sort_order: 0, is_archived: false }],
    location_rate_tier_prices: [
      { tier_id: "t1", chf_per_hour: 100, effective_from: "2026-01-01", effective_to: wechsel },
      { tier_id: "t1", chf_per_hour: 120, effective_from: wechsel, effective_to: null },
    ],
    employee_compensation: [
      { profile_id: "u1", hourly_wage_chf: 30, uses_standard_lohn: false, effective_from: "2026-01-01", effective_to: vortag },
      { profile_id: "u1", hourly_wage_chf: 40, uses_standard_lohn: false, effective_from: wechsel, effective_to: null },
    ],
    profiles: [{ id: "u1", full_name: "Test Person", role: "techniker" }],
  });
}

function stempel(clockInUtc: string, clockOutUtc: string) {
  return { clock_in: clockInUtc, clock_out: clockOutUtc, user_id: "u1", job_id: "j1", rate_tier_id: null };
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
});

describe("loadLocationReport — Stempel am Zuerich-Tag", () => {
  it("00:30 Zuerich am Monatsersten (2026-10-31T23:30Z = 01.11. MEZ) zaehlt zum 01.11.", async () => {
    setup("2026-10-31", "2026-11-01", { time: [stempel("2026-10-31T23:30:00+00:00", "2026-11-01T01:30:00+00:00")] });
    const r = await loadLocationReport("loc1", "2026-01-01", "2026-12-31");
    expect(r?.kpis.total_minutes).toBe(120);
    expect(r?.kpis.personal_vollkosten_chf).toBeCloseTo(80); // 2 h × 40
    expect(r?.kpis.umsatz_chf).toBeCloseTo(240);             // 2 h × 120
    expect(r?.months.find((m) => m.ym === "2026-11")?.minutes).toBe(120);
    expect(r?.months.find((m) => m.ym === "2026-10")).toBeUndefined();
  });

  it("00:30 Zuerich (2026-10-11T22:30Z) zaehlt zum 12.10.", async () => {
    setup("2026-10-11", "2026-10-12", { time: [stempel("2026-10-11T22:30:00+00:00", "2026-10-11T23:30:00+00:00")] });
    const r = await loadLocationReport("loc1", "2026-01-01", "2026-12-31");
    expect(r?.kpis.personal_vollkosten_chf).toBeCloseTo(40);
    expect(r?.kpis.umsatz_chf).toBeCloseTo(120);
  });

  it("Sommerzeit-Beginn: 29.03.2026 00:30 MEZ (2026-03-28T23:30Z)", async () => {
    setup("2026-03-28", "2026-03-29", { time: [stempel("2026-03-28T23:30:00+00:00", "2026-03-29T00:30:00+00:00")] });
    const r = await loadLocationReport("loc1", "2026-01-01", "2026-12-31");
    expect(r?.kpis.personal_vollkosten_chf).toBeCloseTo(40);
    expect(r?.kpis.umsatz_chf).toBeCloseTo(120);
  });

  it("Sommerzeit-Ende: 25.10.2026 00:30 MESZ (2026-10-24T22:30Z)", async () => {
    setup("2026-10-24", "2026-10-25", { time: [stempel("2026-10-24T22:30:00+00:00", "2026-10-24T23:30:00+00:00")] });
    const r = await loadLocationReport("loc1", "2026-01-01", "2026-12-31");
    expect(r?.kpis.personal_vollkosten_chf).toBeCloseTo(40);
    expect(r?.kpis.umsatz_chf).toBeCloseTo(120);
  });

  it("Rapport-Zeit spaet abends behaelt ihr eigenes Datum", async () => {
    setup("2026-10-31", "2026-11-01", {
      reports: [{ job_id: "j1", created_by: "u1", time_ranges: [{ date: "2026-10-31", start: "22:30", end: "23:30", pause: 0 }] }],
    });
    const r = await loadLocationReport("loc1", "2026-01-01", "2026-12-31");
    expect(r?.kpis.total_minutes).toBe(60);
    expect(r?.kpis.personal_vollkosten_chf).toBeCloseTo(30); // Lohn vom 31.10.
    expect(r?.kpis.umsatz_chf).toBeCloseTo(100);
    expect(r?.months.find((m) => m.ym === "2026-10")?.minutes).toBe(60);
  });
});
