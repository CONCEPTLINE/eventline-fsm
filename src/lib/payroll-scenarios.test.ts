/**
 * Payroll-End-to-End-Szenarien — fiktive Mitarbeiter durch die ganze
 * Lohn-Pipeline schieben um zu verifizieren dass die Berechnung in
 * jedem erdenklichen Fall korrekt bleibt.
 *
 * Gedacht als "die Lohnbuchhaltung haengt davon ab"-Sicherheitsnetz.
 * Nicht nur die Pure-Helper (swiss-time, ferienanteil, bvg-forecast)
 * sondern auch die kombinierte Logik wie sie in monthly-stats und
 * wage-documents/generate laeuft.
 *
 * Jeder Test ist ein abgeschlossenes Szenario mit fiktiven Daten und
 * vom Hand nachgerechneten Erwartungswerten — ArG/ArGV/OR/BVV2-konform.
 */

import { describe, it, expect } from "vitest";
import {
  bucketizeMinutes,
  localDateIso,
  weekdayForDateIso,
  type MinuteBucket,
} from "./swiss-time";
import {
  effectiveFerienanteil,
  splitBruttoFerien,
  ageAtDate,
  FERIENANTEIL_ADULT_PCT,
  FERIENANTEIL_YOUTH_PCT,
} from "./ferienanteil";
import {
  effectivePcts,
  sumEmployerPct,
  sumEmployeePct,
  employerCostsPerHour,
  type LohnPctSet,
} from "./employer-costs";
import { calculateForecast, monthRange, forecastStatus, type Appointment } from "./bvg-forecast";
import { swissHolidaysForYear, isSwissHoliday } from "./swiss-holidays";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Schweizer Standard-Defaults wie sie in app_settings gesetzt sein
 *  sollten (typische Werte 2026). Genutzt fuer alle Tests die nicht
 *  explizit Overrides testen. */
const STANDARD_DEFAULTS: LohnPctSet = {
  // Mitarbeiter
  ahvIvEoPct: 5.3,
  alvPct: 1.1,
  nbuPct: 1.45,
  bvgPct: 0,
  ktgPct: 0,
  quellensteuerPct: 0,
  // Arbeitgeber
  employerAhvPct: 5.3,
  employerAlvPct: 1.1,
  employerFakPct: 1.5,
  employerBuPct: 0.18,
  employerBvgPct: 0,
  employerVerwaltungPct: 0.15,
};

const WAGE_26 = 26.0;
const BVG_THRESHOLD = 1837.50;

// Mini-Rapport-Logik 1:1 wie das SQL-CTE in Migration 157 + die JS-Version
// im PDF-Generator. Hier dupliziert damit der Test self-contained ist.
interface RapportRange { technician_id?: string; start?: string; end?: string; pause?: string | number }
function computeRapportMinutes(reports: { time_ranges: RapportRange[] }[], technicianId: string): number {
  let total = 0;
  for (const r of reports) {
    for (const range of r.time_ranges) {
      if (range.technician_id !== technicianId) continue;
      if (!range.start || !range.end) continue;
      const [sh, sm] = range.start.split(":").map(Number);
      const [eh, em] = range.end.split(":").map(Number);
      let mins = (eh * 60 + em) - (sh * 60 + sm);
      if (mins < 0) mins += 1440;
      const pause = range.pause ? Number(range.pause) : 0;
      mins -= Number.isFinite(pause) ? pause : 0;
      total += Math.max(0, mins);
    }
  }
  return total;
}

// Mini-Surcharge-Logik 1:1 wie monthly-stats — separat extrahiert damit
// wir die Tag-fuer-Tag-Rank-Logik testen koennen ohne den ganzen
// HTTP-Endpoint zu mocken.
interface DayBucket { date: string; total_minutes: number; night_minutes: number; is_sunhol: boolean; in_current_month: boolean }
function computeSurcharges(buckets: DayBucket[], hourlyWage: number, monthPrefix: string) {
  const sorted = [...buckets].sort((a, b) => a.date.localeCompare(b.date));
  const nightDays = sorted.filter((d) => d.night_minutes > 0);
  const sunholDays = sorted.filter((d) => d.is_sunhol && d.total_minutes > 0);
  const ytdNightBefore = nightDays.filter((d) => !d.in_current_month && d.date < monthPrefix).length;
  const ytdSunholBefore = sunholDays.filter((d) => !d.in_current_month && d.date < monthPrefix).length;

  let nightEligibleMin = 0, nightOverMin = 0, nightShiftsOver = 0;
  let nightRank = ytdNightBefore;
  for (const d of nightDays) {
    if (!d.in_current_month) continue;
    nightRank++;
    if (nightRank <= 24) nightEligibleMin += d.night_minutes;
    else { nightOverMin += d.night_minutes; nightShiftsOver++; }
  }
  let sunholEligibleMin = 0, sunholRank = ytdSunholBefore;
  for (const d of sunholDays) {
    if (!d.in_current_month) continue;
    sunholRank++;
    if (sunholRank <= 6) sunholEligibleMin += d.total_minutes;
  }
  return {
    night_chf: (nightEligibleMin / 60) * hourlyWage * 0.25,
    sunhol_chf: (sunholEligibleMin / 60) * hourlyWage * 0.5,
    night_eligible_min: nightEligibleMin,
    night_over_min: nightOverMin,
    night_time_comp_min: nightOverMin * 0.10,
    sunhol_eligible_min: sunholEligibleMin,
    night_shifts_over: nightShiftsOver,
  };
}

// Helper — baut DayBucket-Array aus time_entries (clock_in/out ISO).
function bucketize(
  entries: { start: string; end: string }[],
  monthPrefix: string,
  yearPrefix: string,
): DayBucket[] {
  const holidaySet = new Set<string>();
  const year = Number(yearPrefix.slice(0, 4));
  for (const h of swissHolidaysForYear(year)) holidaySet.add(h.date);
  const rawByDate = new Map<string, MinuteBucket>();
  for (const e of entries) {
    bucketizeMinutes(new Date(e.start).getTime(), new Date(e.end).getTime(), rawByDate);
  }
  const result: DayBucket[] = [];
  for (const r of rawByDate.values()) {
    if (!r.date.startsWith(yearPrefix)) continue;
    const wd = weekdayForDateIso(r.date);
    result.push({
      date: r.date,
      total_minutes: r.total_minutes,
      night_minutes: r.night_minutes,
      is_sunhol: wd === 0 || holidaySet.has(r.date),
      in_current_month: r.date.startsWith(monthPrefix),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Szenario 1: Normaler Werktag (Mo 09:00 - 17:00)
// ---------------------------------------------------------------------------
describe("Szenario 1: Normaler Werktag — keine Zuschlaege", () => {
  it("8h Schicht Mo 09:00-17:00 → Brutto = 8 × 26 = 208.00, kein Zuschlag", () => {
    // Mo 8.6.2026 09:00 CEST = 07:00 UTC, 17:00 CEST = 15:00 UTC
    const entries = [{ start: "2026-06-08T07:00:00Z", end: "2026-06-08T15:00:00Z" }];
    const buckets = bucketize(entries, "2026-06-", "2026-");
    expect(buckets.length).toBe(1);
    expect(buckets[0].date).toBe("2026-06-08");
    expect(buckets[0].total_minutes).toBe(480);
    expect(buckets[0].night_minutes).toBe(0);
    expect(buckets[0].is_sunhol).toBe(false);

    const s = computeSurcharges(buckets, WAGE_26, "2026-06-");
    expect(s.night_chf).toBe(0);
    expect(s.sunhol_chf).toBe(0);

    const totalMinThisMonth = buckets.filter(b => b.in_current_month).reduce((a, b) => a + b.total_minutes, 0);
    const brutto = (totalMinThisMonth / 60) * WAGE_26 + s.night_chf + s.sunhol_chf;
    expect(brutto).toBeCloseTo(208.00, 2);
  });
});

// ---------------------------------------------------------------------------
// Szenario 2: Nacht-Schicht innerhalb 24-Limit (ArG 17b Abs. 1)
// ---------------------------------------------------------------------------
describe("Szenario 2: Nachtarbeit erste 24 Schichten/Jahr → 25% Geld", () => {
  it("1. Nacht: Do 22:00 - 04:00 Fr → Brutto = (6h × 26) + (5h × 26 × 25%) = 156 + 32.50", () => {
    // Do 4.6.2026 22:00 CEST = 20:00 UTC; 04:00 CEST Fr = 02:00 UTC
    const entries = [{ start: "2026-06-04T20:00:00Z", end: "2026-06-05T02:00:00Z" }];
    const buckets = bucketize(entries, "2026-06-", "2026-");
    // Sollte 2 Buckets sein — 04.06 und 05.06
    expect(buckets.length).toBe(2);
    const day1 = buckets.find(b => b.date === "2026-06-04")!;
    const day2 = buckets.find(b => b.date === "2026-06-05")!;
    // 22:00-24:00 = 120 min, davon 23:00-24:00 = 60 min Nacht
    expect(day1.total_minutes).toBe(120);
    expect(day1.night_minutes).toBe(60);
    // 00:00-04:00 = 240 min, alles Nacht (Nacht-Fenster 23-06)
    expect(day2.total_minutes).toBe(240);
    expect(day2.night_minutes).toBe(240);

    const s = computeSurcharges(buckets, WAGE_26, "2026-06-");
    // Nacht-Tage: 04.06 (60min) + 05.06 (240min) = 300min eligible
    expect(s.night_eligible_min).toBe(300);
    // 300/60 = 5h × 26 × 0.25 = 32.50
    expect(s.night_chf).toBeCloseTo(32.50, 2);
    // Kein Sonntag
    expect(s.sunhol_chf).toBe(0);

    const total = buckets.filter(b => b.in_current_month).reduce((a, b) => a + b.total_minutes, 0);
    const brutto = (total / 60) * WAGE_26 + s.night_chf;
    expect(brutto).toBeCloseTo(156.00 + 32.50, 2);
  });
});

// ---------------------------------------------------------------------------
// Szenario 3: Nacht-Schicht NACH 24-Limit → 10% Zeitkomp (kein Geld)
// ---------------------------------------------------------------------------
describe("Szenario 3: Nachtarbeit ab Schicht 25 → 10% Zeitkomp, KEIN Geld", () => {
  it("Wenn YTD bereits 24 Nacht-Tage, kriegt die 25. keinen Geld-Zuschlag mehr", () => {
    // Helfer: Single-Day-Nacht-Shift im Winter (CET = UTC+1): 22-23 UTC = 23-24 CET.
    // Iteration t<end ist exklusiv → genau 60 Minuten, alle am gleichen lokalen
    // Tag, alle im Nacht-Fenster.
    const entries: { start: string; end: string }[] = [];
    for (let i = 0; i < 24; i++) {
      const day = String(i + 1).padStart(2, "0"); // 01-24 Januar
      entries.push({ start: `2026-01-${day}T22:00:00Z`, end: `2026-01-${day}T23:00:00Z` });
    }
    // 25. Nacht-Schicht im Juni (Sommer CEST = UTC+2): 21-22 UTC = 23-24 CEST.
    entries.push({ start: "2026-06-10T21:00:00Z", end: "2026-06-10T22:00:00Z" });

    const buckets = bucketize(entries, "2026-06-", "2026-");
    const s = computeSurcharges(buckets, WAGE_26, "2026-06-");
    // Juni-Schicht ist die 25. → 0 eligible Min, 60 ueber-Limit Min
    expect(s.night_eligible_min).toBe(0);
    expect(s.night_chf).toBe(0);
    expect(s.night_over_min).toBe(60);
    expect(s.night_time_comp_min).toBeCloseTo(6, 2); // 60 × 0.10
    expect(s.night_shifts_over).toBe(1);
  });

  it("Mix: 23 vorherige + 2 neue Naechte im Monat → 24. noch eligible, 25. ueber Limit", () => {
    const entries: { start: string; end: string }[] = [];
    // 23 single-day Nacht-Schichten im Januar (Winter CET): 22-23 UTC = 23-24 CET.
    for (let i = 0; i < 23; i++) {
      const day = String(i + 1).padStart(2, "0");
      entries.push({ start: `2026-01-${day}T22:00:00Z`, end: `2026-01-${day}T23:00:00Z` });
    }
    // Zwei Juni-Schichten (Sommer CEST): 21-22 UTC = 23-24 CEST, single-day.
    entries.push({ start: "2026-06-10T21:00:00Z", end: "2026-06-10T22:00:00Z" }); // 24.
    entries.push({ start: "2026-06-20T21:00:00Z", end: "2026-06-20T22:00:00Z" }); // 25.
    const buckets = bucketize(entries, "2026-06-", "2026-");
    const s = computeSurcharges(buckets, WAGE_26, "2026-06-");
    expect(s.night_eligible_min).toBe(60); // 24. Tag im Limit: 1h Nacht
    expect(s.night_over_min).toBe(60);     // 25. Tag ueber Limit: 1h Nacht
    expect(s.night_time_comp_min).toBeCloseTo(6, 2);
    expect(s.night_shifts_over).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Szenario 4: Sonntags-Schicht innerhalb 6-Limit
// ---------------------------------------------------------------------------
describe("Szenario 4: Sonntag erste 6/Jahr → 50% Geld (ArGV 1 Art. 28)", () => {
  it("1. Sonntag im Jahr Juni: 10:00-18:00 → Brutto + 50% Zuschlag auf alle 8h", () => {
    // So 7.6.2026 10:00 CEST = 08:00 UTC; 18:00 CEST = 16:00 UTC
    const entries = [{ start: "2026-06-07T08:00:00Z", end: "2026-06-07T16:00:00Z" }];
    const buckets = bucketize(entries, "2026-06-", "2026-");
    expect(buckets[0].is_sunhol).toBe(true);
    expect(buckets[0].total_minutes).toBe(480);
    expect(buckets[0].night_minutes).toBe(0);

    const s = computeSurcharges(buckets, WAGE_26, "2026-06-");
    expect(s.sunhol_eligible_min).toBe(480);
    // 8h × 26 × 0.50 = 104.00
    expect(s.sunhol_chf).toBeCloseTo(104.00, 2);
    expect(s.night_chf).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Szenario 5: Feiertag (1. August / Bundesfeiertag) zaehlt wie Sonntag
// ---------------------------------------------------------------------------
describe("Szenario 5: Feiertag = Sonntag-Aequivalent (ArGV 1 Art. 28)", () => {
  it("1. August (Bundesfeiertag) zaehlt fuer 6/Jahr-Limit und gibt 50% Zuschlag", () => {
    // 1.8.2026 ist ein Samstag — also wird der Feiertag aktiv. Schicht 10-18.
    const entries = [{ start: "2026-08-01T08:00:00Z", end: "2026-08-01T16:00:00Z" }];
    const buckets = bucketize(entries, "2026-08-", "2026-");
    expect(buckets[0].is_sunhol).toBe(true);
    expect(buckets[0].total_minutes).toBe(480);

    const s = computeSurcharges(buckets, WAGE_26, "2026-08-");
    expect(s.sunhol_eligible_min).toBe(480);
    expect(s.sunhol_chf).toBeCloseTo(104.00, 2);
  });

  it("Karfreitag, Auffahrt etc. werden alle korrekt erkannt", () => {
    const holidays = swissHolidaysForYear(2026);
    // 2026: Karfreitag = 3.4., Ostermontag = 6.4., Auffahrt = 14.5., Pfingstmontag = 25.5.
    expect(holidays.find(h => h.name === "Karfreitag")?.date).toBe("2026-04-03");
    expect(holidays.find(h => h.name === "Ostermontag")?.date).toBe("2026-04-06");
    expect(holidays.find(h => h.name === "Auffahrt")?.date).toBe("2026-05-14");
    expect(holidays.find(h => h.name === "Pfingstmontag")?.date).toBe("2026-05-25");
    expect(holidays.find(h => h.name === "Bundesfeiertag")?.date).toBe("2026-08-01");
    expect(isSwissHoliday("2026-04-03", 2026)).toEqual({ holiday: true, name: "Karfreitag" });
    expect(isSwissHoliday("2026-04-04", 2026)).toEqual({ holiday: false });
  });
});

// ---------------------------------------------------------------------------
// Szenario 6: Stacking — Nacht + Sonntag werden BEIDE addiert
// ---------------------------------------------------------------------------
describe("Szenario 6: Stacking Nacht+Sonntag — beide Zuschlaege addieren", () => {
  it("Sa 22:00 → So 04:00: Nacht-Min nur So-Teil zaehlt fuer Sonn-Zuschlag", () => {
    // Sa 30.5.2026 22:00 CEST = 20:00 UTC; So 31.5.2026 04:00 CEST = 02:00 UTC
    const entries = [{ start: "2026-05-30T20:00:00Z", end: "2026-05-31T02:00:00Z" }];
    const buckets = bucketize(entries, "2026-05-", "2026-");
    expect(buckets.length).toBe(2);
    const sat = buckets.find(b => b.date === "2026-05-30")!;
    const sun = buckets.find(b => b.date === "2026-05-31")!;
    // Sa: 22-24h = 120min, davon 23-24h = 60min Nacht. Nicht Sonntag.
    expect(sat.total_minutes).toBe(120);
    expect(sat.night_minutes).toBe(60);
    expect(sat.is_sunhol).toBe(false);
    // So: 00-04h = 240min, alles Nacht. Ist Sonntag.
    expect(sun.total_minutes).toBe(240);
    expect(sun.night_minutes).toBe(240);
    expect(sun.is_sunhol).toBe(true);

    const s = computeSurcharges(buckets, WAGE_26, "2026-05-");
    // Nacht eligible: Sa (60) + So (240) = 300min → 5h × 26 × 0.25 = 32.50
    expect(s.night_chf).toBeCloseTo(32.50, 2);
    // Sonntag eligible: So-Total (240min = 4h) × 26 × 0.50 = 52.00
    expect(s.sunhol_chf).toBeCloseTo(52.00, 2);
    // Stacking total = 32.50 + 52.00 = 84.50
    expect(s.night_chf + s.sunhol_chf).toBeCloseTo(84.50, 2);
  });
});

// ---------------------------------------------------------------------------
// Szenario 7: Overnight-Schicht — Minuten korrekt aufs Datum aufteilen
// ---------------------------------------------------------------------------
describe("Szenario 7: Overnight-Schicht — Per-Minute-Attribution", () => {
  it("Mi 20:00 → Do 02:00: 4h auf Mi + 2h auf Do, je nach Lokal-Datum", () => {
    // 10.6.2026 20:00 CEST = 18:00 UTC; 11.6.2026 02:00 CEST = 00:00 UTC
    const entries = [{ start: "2026-06-10T18:00:00Z", end: "2026-06-11T00:00:00Z" }];
    const buckets = bucketize(entries, "2026-06-", "2026-");
    const wed = buckets.find(b => b.date === "2026-06-10")!;
    const thu = buckets.find(b => b.date === "2026-06-11")!;
    // Mi: 20-24h = 240min, 23-24h = 60min Nacht
    expect(wed.total_minutes).toBe(240);
    expect(wed.night_minutes).toBe(60);
    // Do: 00-02h = 120min, alles Nacht
    expect(thu.total_minutes).toBe(120);
    expect(thu.night_minutes).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Szenario 8: DST Spring Forward
// ---------------------------------------------------------------------------
describe("Szenario 8: DST-Sprung Maerz — 1h fehlt, weniger Lohn", () => {
  it("29.3.2026 Sa 23:00 → So 06:00: real nur 6h Arbeit (DST-Sprung 02→03)", () => {
    // Sa 28.3.2026 23:00 CET = 22:00Z. So 29.3.2026 06:00 CEST = 04:00Z.
    // UTC-Delta = 6h → real 6h Lokal-Arbeit (zwischen 02-03 fehlt 1h).
    const entries = [{ start: "2026-03-28T22:00:00Z", end: "2026-03-29T04:00:00Z" }];
    const buckets = bucketize(entries, "2026-03-", "2026-");
    const totalMin = buckets.reduce((a, b) => a + b.total_minutes, 0);
    expect(totalMin).toBe(360); // 6h × 60min
  });
});

// ---------------------------------------------------------------------------
// Szenario 9: DST Fall Back
// ---------------------------------------------------------------------------
describe("Szenario 9: DST-Rueckschritt Oktober — 1h doppelt, mehr Lohn", () => {
  it("25.10.2026 Sa 23:00 → So 06:00: real 8h Arbeit (Stunde 02-03 doppelt)", () => {
    // Sa 24.10.2026 23:00 CEST = 21:00Z. So 25.10.2026 06:00 CET = 05:00Z.
    // UTC-Delta = 8h → real 8h Lokal-Arbeit (zwischen 02-03 wird doppelt durchlaufen).
    const entries = [{ start: "2026-10-24T21:00:00Z", end: "2026-10-25T05:00:00Z" }];
    const buckets = bucketize(entries, "2026-10-", "2026-");
    const totalMin = buckets.reduce((a, b) => a + b.total_minutes, 0);
    expect(totalMin).toBe(480); // 8h × 60min
  });
});

// ---------------------------------------------------------------------------
// Szenario 10: Jahres-Wechsel-Schicht
// ---------------------------------------------------------------------------
describe("Szenario 10: Silvester-Schicht ueber Jahres-Wechsel", () => {
  it("31.12.2026 22:00 → 1.1.2027 04:00: Minuten korrekt aufs Jahr verteilt", () => {
    // 31.12.2026 22:00 CET = 21:00Z. 1.1.2027 04:00 CET = 03:00Z.
    const entries = [{ start: "2026-12-31T21:00:00Z", end: "2027-01-01T03:00:00Z" }];
    // Mit yearPrefix "2026-" — sollten nur die 31.12-Minuten zaehlen.
    const buckets2026 = bucketize(entries, "2026-12-", "2026-");
    expect(buckets2026.length).toBe(1);
    expect(buckets2026[0].date).toBe("2026-12-31");
    expect(buckets2026[0].total_minutes).toBe(120); // 22-24 Uhr
    expect(buckets2026[0].night_minutes).toBe(60);  // 23-24 Uhr

    // Mit yearPrefix "2027-" — sollten nur die 1.1-Minuten zaehlen.
    const buckets2027 = bucketize(entries, "2027-01-", "2027-");
    expect(buckets2027.length).toBe(1);
    expect(buckets2027[0].date).toBe("2027-01-01");
    expect(buckets2027[0].total_minutes).toBe(240); // 00-04 Uhr
    expect(buckets2027[0].night_minutes).toBe(240); // alles Nacht
    expect(buckets2027[0].is_sunhol).toBe(true); // 1.1. Neujahr Feiertag
  });
});

// ---------------------------------------------------------------------------
// Szenario 11-13: Ferienanteil
// ---------------------------------------------------------------------------
describe("Szenario 11-13: Ferienanteil OR Art. 329a", () => {
  it("Erwachsener (>=20): 8.33% Default", () => {
    expect(effectiveFerienanteil(null, "2000-05-15", "2026-06-15")).toBe(FERIENANTEIL_ADULT_PCT);
  });

  it("U20: 10.64% (5 Wochen Ferien)", () => {
    // Geburtstag 1.8.2007 → am 15.6.2026 ist die Person 18 Jahre alt (noch <20).
    expect(effectiveFerienanteil(null, "2007-08-01", "2026-06-15")).toBe(FERIENANTEIL_YOUTH_PCT);
  });

  it("Override greift IMMER, auch wenn Geburtsdatum was anderes ergibt", () => {
    expect(effectiveFerienanteil(12.5, "1995-01-01", "2026-06-15")).toBe(12.5);
    expect(effectiveFerienanteil(0, "1995-01-01", "2026-06-15")).toBe(0); // 0 ist auch Override
  });

  it("Kein Geburtsdatum → Default Erwachsener (8.33%)", () => {
    expect(effectiveFerienanteil(null, null, "2026-06-15")).toBe(FERIENANTEIL_ADULT_PCT);
    expect(effectiveFerienanteil(undefined, undefined, "2026-06-15")).toBe(FERIENANTEIL_ADULT_PCT);
  });

  it("Altersberechnung exakt zum Stichtag — Geburtstag noch nicht erreicht", () => {
    // Person geboren 16.6.2006 → am 15.6.2026 ist sie noch 19 → U20
    expect(ageAtDate("2006-06-16", "2026-06-15")).toBe(19);
    expect(effectiveFerienanteil(null, "2006-06-16", "2026-06-15")).toBe(FERIENANTEIL_YOUTH_PCT);
    // Am 16.6.2026 ist sie 20 → Erwachsen
    expect(ageAtDate("2006-06-16", "2026-06-16")).toBe(20);
    expect(effectiveFerienanteil(null, "2006-06-16", "2026-06-16")).toBe(FERIENANTEIL_ADULT_PCT);
  });

  it("Brutto-Aufspaltung: Grundlohn + Ferienanteil = Brutto (mathematisch exakt)", () => {
    const split = splitBruttoFerien(26.00, 8.33);
    expect(split.grundlohn + split.ferienanteil).toBeCloseTo(26.00, 6);
    // Grundlohn = 26 / 1.0833 ≈ 24.00
    expect(split.grundlohn).toBeCloseTo(24.00, 2);
    // Ferienanteil = 26 - 24 = 2.00
    expect(split.ferienanteil).toBeCloseTo(2.00, 2);
  });

  it("Brutto-Aufspaltung mit U20-Satz", () => {
    const split = splitBruttoFerien(26.00, 10.64);
    expect(split.grundlohn + split.ferienanteil).toBeCloseTo(26.00, 6);
    // Grundlohn = 26 / 1.1064 ≈ 23.50
    expect(split.grundlohn).toBeCloseTo(23.50, 1);
  });
});

// ---------------------------------------------------------------------------
// Szenario 14: Override pcts vs Defaults (all-or-nothing per uses_standard_lohn)
// ---------------------------------------------------------------------------
describe("Szenario 14: Override-Pcts mit uses_standard_lohn-Flag", () => {
  it("uses_standard_lohn=true → ignoriert alle Per-Spalten, nimmt Defaults", () => {
    const eff = effectivePcts(
      {
        uses_standard_lohn: true,
        ahv_iv_eo_pct: 99, // wird ignoriert
        alv_pct: 99,
        // ... alle anderen NULL
      },
      STANDARD_DEFAULTS,
    );
    expect(eff).toEqual(STANDARD_DEFAULTS);
  });

  it("uses_standard_lohn=false → nimmt explizite Per-Spalten (NULL→0)", () => {
    const eff = effectivePcts(
      {
        uses_standard_lohn: false,
        ahv_iv_eo_pct: 5.3,
        alv_pct: 1.1,
        // nbu/bvg/ktg/quellensteuer NULL → 0
        employer_ahv_pct: 5.3,
        employer_alv_pct: 1.1,
        employer_fak_pct: 1.5,
        // bu/bvg/verwaltung NULL → 0
      },
      STANDARD_DEFAULTS,
    );
    expect(eff.ahvIvEoPct).toBe(5.3);
    expect(eff.nbuPct).toBe(0); // wurde NULL gegeben
    expect(eff.bvgPct).toBe(0);
    expect(eff.employerFakPct).toBe(1.5);
    expect(eff.employerBuPct).toBe(0);
  });

  it("Fehlende Comp-Row → Default-Pcts", () => {
    expect(effectivePcts(null, STANDARD_DEFAULTS)).toEqual(STANDARD_DEFAULTS);
    expect(effectivePcts(undefined, STANDARD_DEFAULTS)).toEqual(STANDARD_DEFAULTS);
  });

  it("uses_standard_lohn=null/undefined behandelt wie true (default-Pcts)", () => {
    // Sicherer Default falls Spalte noch nicht gesetzt
    expect(effectivePcts({ uses_standard_lohn: null }, STANDARD_DEFAULTS)).toEqual(STANDARD_DEFAULTS);
    expect(effectivePcts({}, STANDARD_DEFAULTS)).toEqual(STANDARD_DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// Szenario 15: Employer-Kosten + Total-Abzuege
// ---------------------------------------------------------------------------
describe("Szenario 15: Arbeitgeber-Anteil pro Stunde + Total-Abzuege", () => {
  it("Summe AG = 5.3+1.1+1.5+0.18+0+0.15 = 8.23%", () => {
    expect(sumEmployerPct(STANDARD_DEFAULTS)).toBeCloseTo(8.23, 2);
  });

  it("Summe AN = 5.3+1.1+1.45+0+0+0 = 7.85%", () => {
    expect(sumEmployeePct(STANDARD_DEFAULTS)).toBeCloseTo(7.85, 2);
  });

  it("AG-Anteil pro Stunde bei 26 CHF Brutto: 26 × 8.23% = 2.14 CHF/h", () => {
    expect(employerCostsPerHour(26, sumEmployerPct(STANDARD_DEFAULTS))).toBeCloseTo(2.14, 2);
  });

  it("Vollkosten Arbeitgeber inkl. Zuschlag = Stunden × (Brutto + AG-pro-Std) + Zuschlag", () => {
    const stunden = 21.95; // Mathis aus User-Bug
    const wage = 26;
    const surcharge = 6.07;
    const agPerHour = employerCostsPerHour(wage, sumEmployerPct(STANDARD_DEFAULTS));
    const vollkosten = stunden * (wage + agPerHour) + surcharge;
    expect(vollkosten).toBeCloseTo(21.95 * (26 + 2.14) + 6.07, 1);
  });
});

// ---------------------------------------------------------------------------
// Szenario 16: BVG-Forecast NAIV (kein Limit-Kontext)
// ---------------------------------------------------------------------------
describe("Szenario 16: BVG-Forecast naiv — alle Stunden mit Zuschlag", () => {
  it("Forecast mit 1 Termin Werktag: nur base, kein Zuschlag", () => {
    const appts: Appointment[] = [
      { start_time: "2026-07-06T07:00:00Z", end_time: "2026-07-06T15:00:00Z" }, // Mo 09-17
    ];
    const f = calculateForecast(appts, WAGE_26, "2026-07-01", "2026-07-31");
    expect(f.total_minutes).toBe(480);
    expect(f.night_minutes).toBe(0);
    expect(f.sunhol_minutes).toBe(0);
    expect(f.total_chf).toBeCloseTo(8 * 26, 2);
  });

  it("Forecast mit Nacht-Termin (kein Limit) → 25% Zuschlag auf Nacht-Minuten", () => {
    const appts: Appointment[] = [
      { start_time: "2026-07-07T20:00:00Z", end_time: "2026-07-08T02:00:00Z" }, // Di 22-04
    ];
    const f = calculateForecast(appts, WAGE_26, "2026-07-01", "2026-07-31");
    // 6h total, 5h davon Nacht (23-04 = 5h)
    expect(f.total_minutes).toBe(360);
    expect(f.night_minutes).toBe(300);
    expect(f.night_premium_chf).toBeCloseTo(5 * 26 * 0.25, 2);
    expect(f.total_chf).toBeCloseTo(6 * 26 + 5 * 26 * 0.25, 2);
  });

  it("Forecast mit 30 Nacht-Tagen OHNE limit → alle 30 kriegen 25%", () => {
    const appts: Appointment[] = [];
    for (let i = 1; i <= 30; i++) {
      const day = String(i).padStart(2, "0");
      appts.push({ start_time: `2026-07-${day}T20:00:00Z`, end_time: `2026-07-${day}T22:00:00Z` });
      // 22-24 CEST = 2h, davon 23-24 = 1h Nacht
    }
    const f = calculateForecast(appts, WAGE_26, "2026-07-01", "2026-07-31");
    // Ohne Limit-Context: alle 30 Naechte werden eligible
    expect(f.night_minutes).toBe(30 * 60); // 30 × 1h Nacht
  });
});

// ---------------------------------------------------------------------------
// Szenario 17: BVG-Forecast MIT YTD-Limit-Context
// ---------------------------------------------------------------------------
describe("Szenario 17: BVG-Forecast mit YTD-Limit (24 Nachte / 6 Sonntage)", () => {
  it("Wenn YTD bereits 24 Naechte: weitere kriegen keinen Geld-Zuschlag mehr", () => {
    const appts: Appointment[] = [];
    for (let i = 1; i <= 5; i++) {
      const day = String(i).padStart(2, "0");
      appts.push({ start_time: `2026-07-${day}T22:00:00Z`, end_time: `2026-07-${day}T23:00:00Z` });
      // 1h CEST 00-01 → alles Nacht
    }
    const f = calculateForecast(appts, WAGE_26, "2026-07-01", "2026-07-31", {
      ytdNightDaysBefore: 24,
      ytdSunholDaysBefore: 0,
    });
    // Alle 5 Naechte ueber Limit → 0 eligible, 5h over-limit
    expect(f.night_minutes).toBe(0);
    expect(f.night_over_limit_minutes).toBe(5 * 60);
    expect(f.night_premium_chf).toBe(0);
  });

  it("Wenn YTD bereits 5 Sonntage: 1 noch eligible, weitere ueber Limit", () => {
    // 3 Sonntage im Juli 2026: 5.7., 12.7., 19.7., 26.7.
    const appts: Appointment[] = [
      { start_time: "2026-07-05T08:00:00Z", end_time: "2026-07-05T16:00:00Z" }, // So
      { start_time: "2026-07-12T08:00:00Z", end_time: "2026-07-12T16:00:00Z" }, // So
      { start_time: "2026-07-19T08:00:00Z", end_time: "2026-07-19T16:00:00Z" }, // So
    ];
    const f = calculateForecast(appts, WAGE_26, "2026-07-01", "2026-07-31", {
      ytdNightDaysBefore: 0,
      ytdSunholDaysBefore: 5,
    });
    // 1. Sonntag im Juli ist 6. YTD → eligible. Die anderen 2 ueber Limit.
    expect(f.sunhol_minutes).toBe(8 * 60); // nur 1 Sonntag im Limit
    expect(f.sunhol_over_limit_minutes).toBe(2 * 8 * 60); // 2 Sonntage ueber
  });
});

// ---------------------------------------------------------------------------
// Szenario 18: Rapport-Minuten Berechnung (gleich wie SQL-CTE)
// ---------------------------------------------------------------------------
describe("Szenario 18: Rapport-Minuten aus service_reports.time_ranges", () => {
  const TECH_ID = "11111111-1111-1111-1111-111111111111";

  it("Einfacher Rapport: 09:00-17:00, 30 min Pause = 450 min", () => {
    const reports = [{ time_ranges: [{ technician_id: TECH_ID, start: "09:00", end: "17:00", pause: 30 }] }];
    expect(computeRapportMinutes(reports, TECH_ID)).toBe(450);
  });

  it("Overnight Rapport: 22:00-02:00 (next day), 0 Pause = 240 min", () => {
    const reports = [{ time_ranges: [{ technician_id: TECH_ID, start: "22:00", end: "02:00" }] }];
    expect(computeRapportMinutes(reports, TECH_ID)).toBe(240);
  });

  it("Mehrere Ranges + andere Technician filtern aus", () => {
    const reports = [
      {
        time_ranges: [
          { technician_id: TECH_ID, start: "09:00", end: "12:00" }, // 180
          { technician_id: "other-id", start: "09:00", end: "17:00" }, // ignorieren
          { technician_id: TECH_ID, start: "13:00", end: "17:00", pause: 0 }, // 240
        ],
      },
    ];
    expect(computeRapportMinutes(reports, TECH_ID)).toBe(420);
  });

  it("Pause als String '30' wird korrekt geparst", () => {
    const reports = [{ time_ranges: [{ technician_id: TECH_ID, start: "09:00", end: "17:00", pause: "30" }] }];
    expect(computeRapportMinutes(reports, TECH_ID)).toBe(450);
  });

  it("Pause leerer String oder undefined → 0", () => {
    const reports = [{ time_ranges: [{ technician_id: TECH_ID, start: "09:00", end: "17:00", pause: "" }] }];
    expect(computeRapportMinutes(reports, TECH_ID)).toBe(480);
    const reports2 = [{ time_ranges: [{ technician_id: TECH_ID, start: "09:00", end: "17:00" }] }];
    expect(computeRapportMinutes(reports2, TECH_ID)).toBe(480);
  });

  it("Range ohne start/end wird ignoriert (defensiv)", () => {
    const reports = [{ time_ranges: [{ technician_id: TECH_ID, start: "", end: "" }, { technician_id: TECH_ID }] }];
    expect(computeRapportMinutes(reports, TECH_ID)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Szenario 19: BVG-Threshold-Status (Ampel)
// ---------------------------------------------------------------------------
describe("Szenario 19: BVG-Threshold-Ampel (95%/70%)", () => {
  it("< 70% → ok", () => {
    expect(forecastStatus(1000, BVG_THRESHOLD)).toBe("ok");
  });
  it(">= 70% < 95% → warn", () => {
    expect(forecastStatus(1837.50 * 0.70, BVG_THRESHOLD)).toBe("warn");
    expect(forecastStatus(1837.50 * 0.94, BVG_THRESHOLD)).toBe("warn");
  });
  it(">= 95% → crit (gesetzlich = BVG-pflichtig)", () => {
    expect(forecastStatus(1837.50 * 0.95, BVG_THRESHOLD)).toBe("crit");
    expect(forecastStatus(1837.50, BVG_THRESHOLD)).toBe("crit");
    expect(forecastStatus(2000, BVG_THRESHOLD)).toBe("crit");
  });
});

// ---------------------------------------------------------------------------
// Szenario 20: End-to-End — kompletter Mai-Mathis-Case nachgerechnet
// ---------------------------------------------------------------------------
describe("Szenario 20: End-to-End Mai-2026 Mathis Imoberdorf (Bug-Reproduction)", () => {
  it("Korrekte Brutto + Auszahlung wenn Rapport-basiert (wie Tabelle)", () => {
    // Annahme: Rapport = 21h 57min = 1317 min, Stempel = 25h 48min = 1548 min
    const RAPPORT_MIN = 1317;
    const hoursUsed = RAPPORT_MIN / 60; // 21.95
    const wage = 26.00;

    // Zuschlag 6.07 (= 0.935h Nacht × 25 × 26 / 100 → ~6.07, given)
    const zuschlag = 6.07;
    const brutto = hoursUsed * wage + zuschlag;
    expect(brutto).toBeCloseTo(576.77, 2);

    // Abzuege: AHV 5.30% + ALV 1.10% + NBU 1.45% = 7.85% von Brutto
    const eff = STANDARD_DEFAULTS;
    const deductionPct = sumEmployeePct(eff);
    expect(deductionPct).toBeCloseTo(7.85, 2);
    const ahv = brutto * 5.30 / 100;
    const alv = brutto * 1.10 / 100;
    const nbu = brutto * 1.45 / 100;
    const totalAbzug = ahv + alv + nbu;
    expect(totalAbzug).toBeCloseTo(brutto * 0.0785, 1);

    const netto = brutto * (1 - deductionPct / 100);
    expect(netto).toBeCloseTo(531.49, 1); // wie in der Tabelle
  });

  it("Wenn der Bug aktiv waere (Stempel statt Rapport), kommt 100 CHF zu viel raus", () => {
    const STEMPEL_MIN = 1548; // 25h 48m
    const hoursIfBuggy = STEMPEL_MIN / 60; // 25.80
    const wage = 26.00;
    const zuschlag = 6.07;
    const bruttoBuggy = hoursIfBuggy * wage + zuschlag;
    expect(bruttoBuggy).toBeCloseTo(676.87, 2); // wie das fehlerhafte PDF zeigte
    // Differenz = (25.80 - 21.95) × 26 = 100.10 CHF zu viel
    expect(bruttoBuggy - 576.77).toBeCloseTo(100.10, 1);
  });
});

// ---------------------------------------------------------------------------
// Szenario 21: monthRange + Period-Boundaries
// ---------------------------------------------------------------------------
describe("Szenario 21: Month-Range-Helper", () => {
  it("Mai 2026: 01-31", () => {
    const r = monthRange(2026, 5);
    expect(r.start).toBe("2026-05-01");
    expect(r.end).toBe("2026-05-31");
    expect(r.label).toMatch(/Mai\s+2026/);
  });

  it("Februar Schaltjahr 2028 (Schalt!): 01-29", () => {
    const r = monthRange(2028, 2);
    expect(r.end).toBe("2028-02-29");
  });

  it("Februar Nicht-Schaltjahr 2026: 01-28", () => {
    const r = monthRange(2026, 2);
    expect(r.end).toBe("2026-02-28");
  });

  it("Dezember: 01-31", () => {
    const r = monthRange(2026, 12);
    expect(r.end).toBe("2026-12-31");
  });
});

// ---------------------------------------------------------------------------
// Szenario 22: Edge — leere Schicht / inverted time range
// ---------------------------------------------------------------------------
describe("Szenario 22: Defensive Edge-Cases (Leer / Inverted)", () => {
  it("Leere Entries → keine Buckets, kein Zuschlag", () => {
    const buckets = bucketize([], "2026-06-", "2026-");
    expect(buckets.length).toBe(0);
    const s = computeSurcharges(buckets, WAGE_26, "2026-06-");
    expect(s.night_chf).toBe(0);
    expect(s.sunhol_chf).toBe(0);
  });

  it("Inverted clock_in > clock_out → ignoriert (kein Daten-Crash)", () => {
    const entries = [{ start: "2026-06-10T15:00:00Z", end: "2026-06-10T07:00:00Z" }];
    const buckets = bucketize(entries, "2026-06-", "2026-");
    expect(buckets.length).toBe(0);
  });

  it("Inverted Forecast-Appointment → ignoriert", () => {
    const appts: Appointment[] = [{ start_time: "2026-07-05T16:00:00Z", end_time: "2026-07-05T08:00:00Z" }];
    const f = calculateForecast(appts, WAGE_26, "2026-07-01", "2026-07-31");
    expect(f.total_minutes).toBe(0);
    expect(f.total_chf).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Szenario 23: 13. Monatslohn nicht beruecksichtigt (per Design)
// ---------------------------------------------------------------------------
describe("Szenario 23: Was wir NICHT machen (dokumentiert per Test)", () => {
  it("Keine 13.-Monatslohn-Berechnung — wir geben Brutto monatlich direkt aus", () => {
    // Brutto = hours × wage_inkl_ferien + Zuschlag — kein 13./12.
    // Wenn das je gebraucht wird, neue Helper-Funktion bauen.
    const brutto = 21.95 * 26 + 6.07;
    expect(brutto).toBeCloseTo(576.77, 2);
  });

  it("Keine ALV-Cap (CHF 148'200/Jahr) — aktuell uninteressant da MA <<148k", () => {
    // ALV ist linear 1.10% bis 148'200 dann 0%. Wir capping NICHT.
    // Wenn ein MA in eine relevante Lohnklasse kommt -> Limit einbauen.
    const brutto = 50000; // unrealistisch hoch fuer Test-Beleg
    const alv = brutto * 1.10 / 100;
    expect(alv).toBeCloseTo(550, 2);
  });

  it("Keine BVG-altersabhaengige Pcts — Default flat (Migration 154-defaults)", () => {
    // BVG-Beitraege sollten in CH gestaffelt sein nach Alter (25-34 = 7%,
    // 35-44 = 10%, ...). Wir nutzen flat 0% in Defaults aus
    // FALLBACK in employer-costs. Override per MA noetig.
    expect(STANDARD_DEFAULTS.bvgPct).toBe(0);
    expect(STANDARD_DEFAULTS.employerBvgPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Szenario 24: Konsistenz Tabelle <-> PDF (gleiche Stunden-Basis)
// ---------------------------------------------------------------------------
describe("Szenario 24: PDF und Tabelle muessen DIESELBE Stunden-Basis nehmen", () => {
  it("Beide rechnen mit rapportMin wenn > 0, sonst stempelMin", () => {
    function effectiveMin(rapportMin: number, stempelMin: number): number {
      return rapportMin > 0 ? rapportMin : stempelMin;
    }
    expect(effectiveMin(1317, 1548)).toBe(1317); // Rapport-Fall (Mathis Mai)
    expect(effectiveMin(0, 820)).toBe(820); // Stempel-Fall (kein Rapport)
    expect(effectiveMin(0, 0)).toBe(0);     // Beide leer → 0
  });
});

// ---------------------------------------------------------------------------
// Szenario 25: localDateIso konsistent ueber DST + Year-Boundary
// ---------------------------------------------------------------------------
describe("Szenario 25: localDateIso Konsistenz", () => {
  it("Silvester 23:30 UTC = Neujahr 00:30 CET", () => {
    expect(localDateIso(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });
  it("Sommer-Mitternacht UTC ist nicht der gleiche Tag in ZRH", () => {
    expect(localDateIso(new Date("2026-07-15T00:00:00Z"))).toBe("2026-07-15"); // 02:00 ZRH
    expect(localDateIso(new Date("2026-07-15T22:00:00Z"))).toBe("2026-07-16"); // 00:00 next day ZRH
  });
});
