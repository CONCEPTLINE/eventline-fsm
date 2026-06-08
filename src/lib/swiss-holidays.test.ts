import { describe, it, expect } from "vitest";
import { swissHolidaysForYear, isSwissHoliday } from "./swiss-holidays";

describe("swiss-holidays", () => {
  it("2026 enthaelt alle bekannten Feiertage", () => {
    const h = swissHolidaysForYear(2026);
    const dates = h.map((x) => x.date);
    expect(dates).toContain("2026-01-01"); // Neujahr
    expect(dates).toContain("2026-01-02"); // Berchtoldstag
    expect(dates).toContain("2026-05-01"); // Tag der Arbeit
    expect(dates).toContain("2026-08-01"); // Bundesfeiertag
    expect(dates).toContain("2026-12-25"); // Weihnachten
    expect(dates).toContain("2026-12-26"); // Stephanstag
  });

  it("Ostern 2026 = 5.4. → Karfreitag 3.4., Ostermontag 6.4.", () => {
    const h = swissHolidaysForYear(2026);
    const dates = h.map((x) => x.date);
    expect(dates).toContain("2026-04-03"); // Karfreitag
    expect(dates).toContain("2026-04-06"); // Ostermontag
  });

  it("Auffahrt 2026 = 14.5. (39 Tage nach Ostern)", () => {
    const h = swissHolidaysForYear(2026);
    const dates = h.map((x) => x.date);
    expect(dates).toContain("2026-05-14");
  });

  it("Pfingstmontag 2026 = 25.5. (50 Tage nach Ostern)", () => {
    const h = swissHolidaysForYear(2026);
    const dates = h.map((x) => x.date);
    expect(dates).toContain("2026-05-25");
  });

  it("isSwissHoliday: hit + miss", () => {
    expect(isSwissHoliday("2026-08-01", 2026)).toEqual({ holiday: true, name: "Bundesfeiertag" });
    expect(isSwissHoliday("2026-03-15", 2026)).toEqual({ holiday: false });
  });

  it("Easter 2027 = 28.3. (verschiedenes Jahr)", () => {
    const h = swissHolidaysForYear(2027);
    const dates = h.map((x) => x.date);
    expect(dates).toContain("2027-03-26"); // Karfreitag (28.3. - 2 = 26.3.)
    expect(dates).toContain("2027-03-29"); // Ostermontag
  });
});
