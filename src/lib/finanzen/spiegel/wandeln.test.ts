import { describe, it, expect } from "vitest";
import { bexioSuchZeit, bexioZeitNachTz, datum, zahl } from "./wandeln";
import { offerteStatus, rechnungStatus } from "./status";

describe("finanzen/spiegel/wandeln", () => {
  describe("bexioSuchZeit", () => {
    it("Sommerzeit (CEST = UTC+2)", () => {
      expect(bexioSuchZeit(new Date("2026-07-15T02:30:00Z"))).toBe("2026-07-15 04:30:00");
    });
    it("Winterzeit (CET = UTC+1)", () => {
      expect(bexioSuchZeit(new Date("2026-01-15T02:30:00Z"))).toBe("2026-01-15 03:30:00");
    });
    it("Mitternacht ohne «24»-Stunde, Tageswechsel korrekt", () => {
      expect(bexioSuchZeit(new Date("2026-01-14T23:00:00Z"))).toBe("2026-01-15 00:00:00");
    });
    it("kein Komma, exakt 19 Zeichen", () => {
      const s = bexioSuchZeit(new Date("2026-10-15T12:00:00Z"));
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(s).not.toContain(",");
    });
  });

  describe("datum", () => {
    it("YYYY-MM-DD bleibt", () => expect(datum("2026-09-01")).toBe("2026-09-01"));
    it("Bexio-Zeit wird gekürzt", () => expect(datum("2019-04-08 13:17:32")).toBe("2019-04-08"));
    it("ISO mit Offset wird gekürzt", () => expect(datum("2026-03-09T10:00:00+01:00")).toBe("2026-03-09"));
    it("ungültig → null", () => {
      expect(datum(null)).toBeNull();
      expect(datum("")).toBeNull();
      expect(datum(20260901)).toBeNull();
      expect(datum("heute")).toBeNull();
    });
  });

  describe("zahl", () => {
    it("String mit 6 Dezimalen bleibt String", () => expect(zahl("1250.000000")).toBe("1250.000000"));
    it("trimmt", () => expect(zahl(" 12.5 ")).toBe("12.5"));
    it("number → String", () => expect(zahl(99.9)).toBe("99.9"));
    it("leer/null/NaN → null", () => {
      expect(zahl("")).toBeNull();
      expect(zahl(null)).toBeNull();
      expect(zahl(undefined)).toBeNull();
      expect(zahl(NaN)).toBeNull();
      expect(zahl({})).toBeNull();
    });
  });

  describe("bexioZeitNachTz", () => {
    it("Bexio-Zeit → Europe/Zurich-Eingabe", () => {
      expect(bexioZeitNachTz("2019-04-08 13:17:32")).toBe("2019-04-08 13:17:32 Europe/Zurich");
    });
    it("ISO mit Offset unverändert", () => {
      expect(bexioZeitNachTz("2026-03-09T10:00:00+01:00")).toBe("2026-03-09T10:00:00+01:00");
    });
    it("ungültig → null", () => {
      expect(bexioZeitNachTz(null)).toBeNull();
      expect(bexioZeitNachTz("2026-03-09")).toBeNull();
    });
  });
});

describe("finanzen/spiegel/status", () => {
  it("Rechnungs-Status-Mapping", () => {
    expect(rechnungStatus(7)).toBe("entwurf");
    expect(rechnungStatus(8)).toBe("offen");
    expect(rechnungStatus(9)).toBe("bezahlt");
    expect(rechnungStatus(16)).toBe("teilbezahlt");
    expect(rechnungStatus(19)).toBe("storniert");
    expect(rechnungStatus(31)).toBe("ueberfaellig");
    expect(rechnungStatus(99)).toBe("unbekannt");
    expect(rechnungStatus(NaN)).toBe("unbekannt");
  });
  it("Offerten-Status-Mapping", () => {
    expect(offerteStatus(1)).toBe("entwurf");
    expect(offerteStatus(2)).toBe("offen");
    expect(offerteStatus(3)).toBe("bestaetigt");
    expect(offerteStatus(4)).toBe("abgelehnt");
    expect(offerteStatus(0)).toBe("unbekannt");
  });
});
