import { describe, expect, it } from "vitest";
import { auftragZeitlage } from "./auftrag-zeitlage";

// Winterzeit: 00:00 Zuerich = 23:00 UTC am Vortag.
const jetzt = new Date("2026-11-02T09:00:00Z"); // Mo 2.11., 10:00 Zuerich
const lage = (start_date: string | null, end_date: string | null, status = "offen") =>
  auftragZeitlage({ status, start_date, end_date }, jetzt);

describe("auftragZeitlage", () => {
  it("ohne Uhrzeit: letzter Tag zaehlt ganz (der fruehere Fehler: heute endend = vergangen)", () => {
    expect(lage("2026-11-01T23:00:00Z", "2026-11-01T23:00:00Z")).toBe("aktiv"); // nur heute
    expect(lage("2026-10-30T23:00:00Z", "2026-11-01T23:00:00Z")).toBe("aktiv"); // mehrtaegig, endet heute
    expect(lage("2026-10-30T23:00:00Z", "2026-11-02T23:00:00Z")).toBe("aktiv"); // endet morgen
    expect(lage("2026-10-30T23:00:00Z", "2026-10-31T23:00:00Z")).toBe("vergangen"); // endete gestern
    expect(lage("2026-11-02T23:00:00Z", "2026-11-02T23:00:00Z")).toBe("kommend"); // morgen
  });

  it("mit Uhrzeit: exakt nach Start und Ende", () => {
    expect(lage("2026-11-02T08:00:00Z", "2026-11-02T12:00:00Z")).toBe("aktiv");
    expect(lage("2026-11-02T17:00:00Z", "2026-11-02T21:00:00Z")).toBe("kommend"); // heute Abend
    expect(lage("2026-11-02T06:00:00Z", "2026-11-02T08:00:00Z")).toBe("vergangen"); // heute frueh vorbei
    expect(lage("2026-11-01T19:00:00Z", "2026-11-02T10:00:00Z")).toBe("aktiv"); // ueber Mitternacht
  });

  it("Start mit Uhrzeit und Ende 00:00: Ende gilt exakt, nicht der ganze Tag", () => {
    expect(lage("2026-11-01T18:00:00Z", "2026-11-01T23:00:00Z")).toBe("vergangen");
  });

  it("fehlendes oder unbrauchbares Ende: bis Ende des Starttags", () => {
    expect(lage("2026-11-02T08:00:00Z", null)).toBe("aktiv");
    expect(lage("2026-11-01T08:00:00Z", null)).toBe("vergangen");
    expect(lage("2026-11-02T08:00:00Z", "2026-11-02T07:00:00Z")).toBe("aktiv");
  });

  it("nur offene Auftraege sind aktiv", () => {
    expect(lage("2026-11-02T08:00:00Z", "2026-11-02T12:00:00Z", "partner_anfrage")).toBe("kommend");
    expect(lage("2026-11-02T08:00:00Z", "2026-11-02T12:00:00Z", "abgeschlossen")).toBe("kommend");
    expect(lage("2026-10-01T08:00:00Z", "2026-10-01T12:00:00Z", "abgeschlossen")).toBe("vergangen");
  });

  it("ohne Datum: kommend; Sommerzeit: 00:00 Zuerich = 22:00 UTC", () => {
    expect(lage(null, null)).toBe("kommend");
    const sommer = new Date("2026-07-15T09:00:00Z");
    expect(auftragZeitlage({ status: "offen", start_date: "2026-07-14T22:00:00Z", end_date: "2026-07-14T22:00:00Z" }, sommer)).toBe("aktiv");
  });
});
