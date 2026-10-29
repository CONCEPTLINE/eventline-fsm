// Tests der Hilfen rund um den Rechenkern (echte Funktionen, keine Kopien).
import { describe, expect, it } from "vitest";
import { feiertageBaselStadt, feiertageBaselStadtJahre, rechneMonat, type Firmensatz } from "./kern";
import { rapportMinuten } from "./info-minuten";
import { forecastStatus, mitPuffer, termineAlsStempel } from "./prognose";

const SATZ: Firmensatz = {
  gueltigAb: "2026-01-01",
  an: { ahvIvEo: 5.3, alv: 1.1, nbu: 1.45, bvg: 0, ktg: 0, quellensteuer: 0 },
  ag: { ahvIvEo: 5.3, alv: 1.1, fak: 1.35, bu: 0.5742, bvg: 0, verwaltung: 0.11 },
  bvgSchwelleMonat: 1890,
};

describe("Feiertage Basel-Stadt", () => {
  it("2026: feste und bewegliche Feiertage (Ostern 5.4.)", () => {
    const d = feiertageBaselStadt(2026).map((f) => f.datum);
    expect(d).toEqual(expect.arrayContaining(["2026-01-01", "2026-01-02", "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-14", "2026-05-25", "2026-08-01", "2026-12-25", "2026-12-26"]));
  });
  it("2027: Ostern 28.3. → Karfreitag 26.3., Ostermontag 29.3.", () => {
    const d = feiertageBaselStadt(2027).map((f) => f.datum);
    expect(d).toEqual(expect.arrayContaining(["2027-03-26", "2027-03-29"]));
  });
});

describe("Sommerzeit-Beginn", () => {
  it("29.3.2026 Sa 23:00 → So 06:00 = 6 h echt gearbeitet, alles Sonntag und Nacht", () => {
    const r = rechneMonat({
      jahr: 2026, monat: 3,
      person: { geburtsdatum: "1990-01-01", anstellungen: null, ahvVerlangtJahre: [] },
      stempel: [{ start: "2026-03-28T23:00:00+01:00", ende: "2026-03-29T06:00:00+02:00" }],
      lohnzeilen: [{ gueltigAb: "2026-01-01", gueltigBis: null, stundenlohn: 26, stundenlohnArt: "inkl_ferien", ferienPctFix: null, ohneLohn: false, eigeneSaetze: null }],
      firmensaetze: [SATZ],
      feiertage: feiertageBaselStadtJahre(2025, 2027),
      auszahlungsdatum: "2026-04-08",
    });
    expect(r.mengen.minuten).toBe(360);
    expect(r.mengen.sonntagMinutenMitZuschlag).toBe(360);
    expect(r.mengen.nachtMinutenMitZuschlag).toBe(360);
    expect(r.mengen.naechte).toHaveLength(1);
  });
});

describe("Rapport-Minuten (nur Information)", () => {
  it("09:00–17:00 mit 30 min Pause = 450", () => expect(rapportMinuten({ start: "09:00", end: "17:00", pause: 30 })).toBe(450));
  it("über Mitternacht 22:00–02:00 = 240", () => expect(rapportMinuten({ start: "22:00", end: "02:00" })).toBe(240));
  it("Pause als Text, fehlende Zeiten", () => {
    expect(rapportMinuten({ start: "08:00", end: "12:00", pause: "30" })).toBe(210);
    expect(rapportMinuten({ start: "08:00" })).toBe(0);
  });
});

describe("Prognose", () => {
  it("Termine ohne Ende zählen nicht, nur künftige ab Zeitpunkt", () => {
    const t = [
      { start_time: "2026-11-02T08:00:00Z", end_time: "2026-11-02T10:00:00Z" },
      { start_time: "2026-11-03T08:00:00Z", end_time: null },
      { start_time: "2026-10-01T08:00:00Z", end_time: "2026-10-01T10:00:00Z" },
    ];
    expect(termineAlsStempel(t, Date.parse("2026-10-29T00:00:00Z"))).toHaveLength(1);
  });
  it("Puffer 20 % nur auf den geplanten Teil, Ampel", () => {
    expect(mitPuffer(100, 200)).toBe(220);
    expect(forecastStatus(1800, 1890)).toBe("crit");
    expect(forecastStatus(1400, 1890)).toBe("warn");
    expect(forecastStatus(100, 1890)).toBe("ok");
  });
});
