import { describe, expect, it } from "vitest";
import { darfAbwesenheitsgrundSehen, typFuerBetrachter } from "./abwesenheit-sichtbarkeit";

describe("typFuerBetrachter", () => {
  it("maskiert krank fuer Kolleginnen und Kollegen", () => {
    expect(typFuerBetrachter("krank", { eigen: false, privilegiert: false })).toBe("abwesend");
  });
  it("zeigt krank der Person selbst", () => {
    expect(typFuerBetrachter("krank", { eigen: true, privilegiert: false })).toBe("krank");
  });
  it("zeigt krank der berechtigten Gruppe", () => {
    expect(typFuerBetrachter("krank", { eigen: false, privilegiert: true })).toBe("krank");
  });
  it("laesst andere Typen unveraendert", () => {
    for (const t of ["ferien", "frei", "militaer", "kompensation"] as const) {
      expect(typFuerBetrachter(t, { eigen: false, privilegiert: false })).toBe(t);
    }
  });
});

describe("darfAbwesenheitsgrundSehen", () => {
  it("ferien:approve oder tickets:manage", () => {
    expect(darfAbwesenheitsgrundSehen((r) => r === "ferien:approve")).toBe(true);
    expect(darfAbwesenheitsgrundSehen((r) => r === "tickets:manage")).toBe(true);
    expect(darfAbwesenheitsgrundSehen((r) => r === "stempelzeiten:see-all")).toBe(false);
    expect(darfAbwesenheitsgrundSehen(() => false)).toBe(false);
  });
});
