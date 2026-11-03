import { describe, expect, it } from "vitest";
import { jahrAbfrageGrenzen, minutenJeMonat } from "./stunden";

describe("minutenJeMonat", () => {
  it("teilt einen Stempel über Monatsende nach Ortszeit (Zürich) auf", () => {
    // 31.10.2026 22:00 bis 01.11.2026 02:00 Ortszeit (Winterzeit, UTC+1)
    const m = minutenJeMonat([{ start: "2026-10-31T21:00:00Z", ende: "2026-11-01T01:00:00Z" }]);
    expect(m.get("2026-10")).toBe(120);
    expect(m.get("2026-11")).toBe(120);
  });
  it("Überlappungen zählen einmal, offene Stempel nicht", () => {
    const m = minutenJeMonat([
      { start: "2026-09-10T08:00:00Z", ende: "2026-09-10T12:00:00Z" },
      { start: "2026-09-10T10:00:00Z", ende: "2026-09-10T14:00:00Z" },
      { start: "2026-09-11T08:00:00Z", ende: null },
    ]);
    expect(m.get("2026-09")).toBe(360);
    expect(m.size).toBe(1);
  });
  it("Abfragegrenzen umfassen das ganze Jahr mit Puffer", () => {
    expect(jahrAbfrageGrenzen(2026)).toEqual({ von: "2025-12-30T00:00:00.000Z", bis: "2027-01-02T00:00:00.000Z" });
  });
});
