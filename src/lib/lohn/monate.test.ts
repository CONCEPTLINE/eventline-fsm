import { describe, it, expect } from "vitest";
import { monatLabel, monatsLetzter, sperrtAb } from "./monate";
import { geheimnisGleich, istCronAufruf } from "@/lib/geheimnis";
import { ANFRAGE_GUELTIG_STUNDEN, anfrageAbgelaufen } from "@/lib/geraete-freigabe";

describe("Monatssperre (ab dem 5. des Folgemonats)", () => {
  it("Sperre ab dem 5. des Folgemonats, auch über den Jahreswechsel", () => {
    expect(sperrtAb({ jahr: 2026, monat: 9 })).toBe("2026-10-05");
    expect(sperrtAb({ jahr: 2026, monat: 12 })).toBe("2027-01-05");
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
