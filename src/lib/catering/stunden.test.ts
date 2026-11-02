import { describe, expect, it } from "vitest";
import { formatStunden, minutenZuStunden, stundenZuMinuten } from "./stunden";

describe("Stunden", () => {
  it("rechnet Minuten in Stunden um (ohne überflüssige Nullen)", () => {
    expect(minutenZuStunden(45)).toBe("0.75");
    expect(minutenZuStunden(90)).toBe("1.5");
    expect(minutenZuStunden(60)).toBe("1");
    expect(minutenZuStunden(20)).toBe("0.33");
    expect(minutenZuStunden(215)).toBe("3.58");
    expect(minutenZuStunden(0)).toBe("0");
  });
  it("liest Stundentexte als ganze Minuten, auch mit Komma", () => {
    expect(stundenZuMinuten("0.75")).toBe(45);
    expect(stundenZuMinuten("1,5")).toBe(90);
    expect(stundenZuMinuten("3.58")).toBe(215);
    expect(stundenZuMinuten("0.33")).toBe(20);
    expect(stundenZuMinuten("0")).toBe(0);
  });
  it("lehnt Leeres, Text und Negatives ab", () => {
    for (const t of ["", "  ", "abc", "-1", "NaN", "Infinity"]) expect(stundenZuMinuten(t)).toBeNull();
  });
  it("Hin- und Rückweg bleibt auf die Minute genau für die üblichen Werte", () => {
    for (const m of [0, 15, 30, 45, 60, 75, 90, 120, 180, 215, 240, 300]) expect(stundenZuMinuten(minutenZuStunden(m))).toBe(m);
  });
  it("formatiert für Verträge", () => {
    expect(formatStunden(45)).toBe("0.75 Std.");
  });
});
