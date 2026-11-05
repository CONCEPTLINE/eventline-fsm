import { describe, it, expect } from "vitest";
import { chfAusMinuten, satzAm, satzVerlauf } from "./personal-saetze";

const verlauf = satzVerlauf([
  // absichtlich unsortiert, Zahlen auch als Text (numeric aus der DB)
  { profile_id: "a", gueltig_ab: "2026-11-15", satz: 40 },
  { profile_id: "a", gueltig_ab: "2026-11-01", satz: "30" as unknown as number },
  { profile_id: "b", gueltig_ab: "2026-01-01", satz: null }, // Provisionslohn
  { profile_id: "c", gueltig_ab: "2026-10-01", satz: 25 },
  { profile_id: "c", gueltig_ab: "2026-12-01", satz: null }, // ab Dezember ohne Satz
]);

describe("satzAm — gültiger Satz am Tag", () => {
  it("Wechsel mitten im Monat: bis 14.11. alt, ab 15.11. neu", () => {
    expect(satzAm(verlauf, "a", "2026-11-01")).toBe(30);
    expect(satzAm(verlauf, "a", "2026-11-14")).toBe(30);
    expect(satzAm(verlauf, "a", "2026-11-15")).toBe(40);
    expect(satzAm(verlauf, "a", "2027-03-01")).toBe(40);
  });

  it("vor dem ersten gueltig_ab → null", () => {
    expect(satzAm(verlauf, "a", "2026-10-31")).toBeNull();
  });

  it("Satz null (z. B. Provisionslohn) → null", () => {
    expect(satzAm(verlauf, "b", "2026-06-01")).toBeNull();
  });

  it("späterer Eintrag null beendet den Satz", () => {
    expect(satzAm(verlauf, "c", "2026-11-30")).toBe(25);
    expect(satzAm(verlauf, "c", "2026-12-01")).toBeNull();
  });

  it("unbekannte Person → null", () => {
    expect(satzAm(verlauf, "x", "2026-11-20")).toBeNull();
  });
});

describe("chfAusMinuten — Minuten je Tag × Satz am Tag", () => {
  it("rechnet je Tag mit dem dann gültigen Satz", () => {
    const r = chfAusMinuten(verlauf, "a", new Map([["2026-11-14", 120], ["2026-11-15", 60]]));
    expect(r.chf).toBeCloseTo(2 * 30 + 1 * 40);
    expect(r.minutenMitSatz).toBe(180);
    expect(r.minutenOhneSatz).toBe(0);
  });

  it("Tage ohne Satz zählen nicht als 0 CHF, sondern als «ohne Satz»", () => {
    const r = chfAusMinuten(verlauf, "a", new Map([["2026-10-31", 60], ["2026-11-02", 60]]));
    expect(r.chf).toBeCloseTo(30);
    expect(r.minutenMitSatz).toBe(60);
    expect(r.minutenOhneSatz).toBe(60);
  });

  it("Person mit Satz null: nur «ohne Satz»", () => {
    const r = chfAusMinuten(verlauf, "b", new Map([["2026-11-02", 90]]));
    expect(r).toEqual({ chf: 0, minutenMitSatz: 0, minutenOhneSatz: 90 });
  });
});
