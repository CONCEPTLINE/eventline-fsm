import { describe, it, expect } from "vitest";
import {
  gesperrteMonateAb,
  istMonatGesperrt,
  letzteGesperrteMonate,
  letzterGesperrterMonat,
  monatLabel,
  monatsLetzter,
  sperrtAb,
} from "./monate";
import { geheimnisGleich, istCronAufruf } from "@/lib/geheimnis";
import { ANFRAGE_GUELTIG_STUNDEN, anfrageAbgelaufen } from "@/lib/geraete-freigabe";

describe("Monatssperre (ab dem 5. des Folgemonats)", () => {
  it("September ist am 4.10. offen, am 5.10. gesperrt", () => {
    expect(istMonatGesperrt({ jahr: 2026, monat: 9 }, "2026-10-04")).toBe(false);
    expect(istMonatGesperrt({ jahr: 2026, monat: 9 }, "2026-10-05")).toBe(true);
  });
  it("laufender Monat ist nie gesperrt (Befund 2: keine halbe Abrechnung)", () => {
    expect(istMonatGesperrt({ jahr: 2026, monat: 10 }, "2026-10-29")).toBe(false);
  });
  it("Jahreswechsel: Dezember sperrt am 5. Januar", () => {
    expect(sperrtAb({ jahr: 2026, monat: 12 })).toBe("2027-01-05");
    expect(istMonatGesperrt({ jahr: 2026, monat: 12 }, "2027-01-04")).toBe(false);
    expect(istMonatGesperrt({ jahr: 2026, monat: 12 }, "2027-01-05")).toBe(true);
  });
  it("Vorgabe = letzter gesperrter Monat", () => {
    expect(letzterGesperrterMonat("2026-10-29")).toEqual({ jahr: 2026, monat: 9 });
    expect(letzterGesperrterMonat("2026-11-04")).toEqual({ jahr: 2026, monat: 9 });
    expect(letzterGesperrterMonat("2026-11-05")).toEqual({ jahr: 2026, monat: 10 });
    expect(letzterGesperrterMonat("2027-01-03")).toEqual({ jahr: 2026, monat: 11 });
    expect(letzterGesperrterMonat("2027-02-01")).toEqual({ jahr: 2026, monat: 12 });
  });
  it("alle gesperrten Monate ab einem Startmonat (Nachholen)", () => {
    expect(gesperrteMonateAb({ jahr: 2026, monat: 7 }, "2026-10-29")).toEqual([
      { jahr: 2026, monat: 7 },
      { jahr: 2026, monat: 8 },
      { jahr: 2026, monat: 9 },
    ]);
    expect(gesperrteMonateAb({ jahr: 2026, monat: 10 }, "2026-10-29")).toEqual([]);
    expect(gesperrteMonateAb({ jahr: 2026, monat: 11 }, "2027-01-05")).toEqual([
      { jahr: 2026, monat: 11 },
      { jahr: 2026, monat: 12 },
    ]);
  });
  it("Auswahl im UI: neuester zuerst, über den Jahreswechsel", () => {
    expect(letzteGesperrteMonate("2027-02-10", 3)).toEqual([
      { jahr: 2027, monat: 1 },
      { jahr: 2026, monat: 12 },
      { jahr: 2026, monat: 11 },
    ]);
  });
  it("Monatsende und Label", () => {
    expect(monatsLetzter({ jahr: 2028, monat: 2 })).toBe("2028-02-29");
    expect(monatsLetzter({ jahr: 2026, monat: 2 })).toBe("2026-02-28");
    expect(monatLabel({ jahr: 2026, monat: 3 })).toBe("März 2026");
  });
});

describe("Zeitsicherer Geheimnis-Vergleich", () => {
  it("vergleicht korrekt und lehnt Leeres ab", () => {
    expect(geheimnisGleich("abc", "abc")).toBe(true);
    expect(geheimnisGleich("abc", "abd")).toBe(false);
    expect(geheimnisGleich("abc", "abcd")).toBe(false);
    expect(geheimnisGleich("", "")).toBe(false);
    expect(geheimnisGleich(null, "x")).toBe(false);
    expect(geheimnisGleich("x", undefined)).toBe(false);
  });
  it("Cron-Aufruf nur mit gesetztem Geheimnis und passendem Bearer", () => {
    const alt = process.env.CRON_SECRET;
    try {
      delete process.env.CRON_SECRET;
      expect(istCronAufruf(new Request("http://x", { headers: { authorization: "Bearer " } }))).toBe(false);
      process.env.CRON_SECRET = "geheim-123";
      expect(istCronAufruf(new Request("http://x", { headers: { authorization: "Bearer geheim-123" } }))).toBe(true);
      expect(istCronAufruf(new Request("http://x", { headers: { authorization: "Bearer geheim-12" } }))).toBe(false);
      expect(istCronAufruf(new Request("http://x"))).toBe(false);
    } finally {
      if (alt === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = alt;
    }
  });
});

describe("Gerätefreigabe: Anfrage 24 h gültig", () => {
  const jetzt = new Date("2026-10-29T12:00:00Z");
  it("mit gueltig_bis", () => {
    expect(anfrageAbgelaufen({ anfrage_gueltig_bis: "2026-10-29T12:00:01Z" }, jetzt)).toBe(false);
    expect(anfrageAbgelaufen({ anfrage_gueltig_bis: "2026-10-29T12:00:00Z" }, jetzt)).toBe(true);
  });
  it("alte Anfragen ohne gueltig_bis zählen ab requested_at", () => {
    const vor = (h: number) => new Date(jetzt.getTime() - h * 3600_000).toISOString();
    expect(anfrageAbgelaufen({ requested_at: vor(ANFRAGE_GUELTIG_STUNDEN - 1) }, jetzt)).toBe(false);
    expect(anfrageAbgelaufen({ requested_at: vor(ANFRAGE_GUELTIG_STUNDEN + 1) }, jetzt)).toBe(true);
    expect(anfrageAbgelaufen({}, jetzt)).toBe(true);
  });
});
