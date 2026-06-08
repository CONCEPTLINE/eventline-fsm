import { describe, it, expect } from "vitest";
import { localDateIso, localHour, localWeekday, weekdayForDateIso, bucketizeMinutes } from "./swiss-time";

describe("swiss-time", () => {
  describe("localDateIso", () => {
    it("formatted in Europe/Zurich for typical winter date", () => {
      const d = new Date("2026-01-15T12:00:00Z"); // UTC 12:00 → 13:00 CET
      expect(localDateIso(d)).toBe("2026-01-15");
    });

    it("handles UTC midnight that is local 01:00 same day", () => {
      const d = new Date("2026-01-15T23:30:00Z"); // UTC 23:30 → 00:30 CET next day
      expect(localDateIso(d)).toBe("2026-01-16");
    });

    it("summer offset CEST = UTC+2", () => {
      const d = new Date("2026-07-15T22:30:00Z"); // 00:30 CEST next day
      expect(localDateIso(d)).toBe("2026-07-16");
    });
  });

  describe("localHour", () => {
    it("returns local hour, not UTC", () => {
      const d = new Date("2026-01-15T22:00:00Z"); // 23:00 CET
      expect(localHour(d)).toBe(23);
    });

    it("midnight rollover", () => {
      const d = new Date("2026-01-15T23:30:00Z"); // 00:30 CET
      expect(localHour(d)).toBe(0);
    });
  });

  describe("localWeekday", () => {
    it("Sunday returns 0", () => {
      // 2026-05-31 is a Sunday
      const d = new Date("2026-05-31T12:00:00Z");
      expect(localWeekday(d)).toBe(0);
    });

    it("Monday returns 1", () => {
      const d = new Date("2026-06-01T12:00:00Z");
      expect(localWeekday(d)).toBe(1);
    });
  });

  describe("weekdayForDateIso", () => {
    it("works from date string only", () => {
      expect(weekdayForDateIso("2026-05-31")).toBe(0); // Sunday
      expect(weekdayForDateIso("2026-06-01")).toBe(1); // Monday
    });
  });

  describe("bucketizeMinutes — DST + cross-midnight", () => {
    it("attributes minutes correctly across midnight (Sat 22:00 → Sun 03:00 local)", () => {
      // Sa 30.5.2026 22:00 CEST = 20:00 UTC
      // So 31.5.2026 03:00 CEST = 01:00 UTC
      const start = new Date("2026-05-30T20:00:00Z").getTime();
      const end = new Date("2026-05-31T01:00:00Z").getTime();
      const perDate = new Map();
      bucketizeMinutes(start, end, perDate);

      // Sa: 2h (22-24) = 120 min, davon 1h (23-24) = 60 min Nacht
      const sat = perDate.get("2026-05-30");
      expect(sat?.total_minutes).toBe(120);
      expect(sat?.night_minutes).toBe(60);

      // So: 3h (0-3) = 180 min, alle Nacht
      const sun = perDate.get("2026-05-31");
      expect(sun?.total_minutes).toBe(180);
      expect(sun?.night_minutes).toBe(180);
    });

    it("DST spring forward (Mar 29 2026): 23:00 → 06:00 local is 6h real, 7h UTC", () => {
      // DST-Sprung 29.3.2026: 02:00 → 03:00 (springt 1h). 23:00 CET → 06:00 CEST = 6h Lokal.
      // UTC: 22:00 CET = 22:00Z; 06:00 CEST = 04:00Z → 6 UTC-Stunden.
      // Actually: 23:00 CET = 23:00Z minus 1h offset = 22:00Z. 06:00 CEST = 04:00Z.
      // Differenz = 6 UTC-Stunden = real 6h Lokal-Arbeitszeit.
      const start = new Date("2026-03-28T22:00:00Z").getTime(); // 23:00 CET Sa
      const end = new Date("2026-03-29T04:00:00Z").getTime();   // 06:00 CEST So
      const perDate = new Map();
      bucketizeMinutes(start, end, perDate);

      const totalMinutes = Array.from(perDate.values()).reduce((s, b) => s + b.total_minutes, 0);
      // 6 UTC-Stunden = 360 Minuten Lokal-Arbeitszeit
      expect(totalMinutes).toBe(360);
    });

    it("empty interval", () => {
      const perDate = new Map();
      bucketizeMinutes(1000, 1000, perDate);
      expect(perDate.size).toBe(0);
    });

    it("inverted interval", () => {
      const perDate = new Map();
      bucketizeMinutes(2000, 1000, perDate);
      expect(perDate.size).toBe(0);
    });
  });
});
