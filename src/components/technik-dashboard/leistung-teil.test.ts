import { describe, expect, it } from "vitest";
import { anteile, dauerKurz, pct } from "./leistung-teil";

describe("Leistung: Anzeige-Helfer", () => {
  it("Dauer kurz mit sinnvollen Stellen", () => {
    expect(dauerKurz(59)).toBe("0,06 s");
    expect(dauerKurz(500)).toBe("0,5 s");
    expect(dauerKurz(670)).toBe("0,7 s");
    expect(dauerKurz(4355)).toBe("4,4 s");
    expect(dauerKurz(9_960)).toBe("10 s");
    expect(dauerKurz(16_075)).toBe("16 s");
    expect(dauerKurz(105_300)).toBe("1:45 min");
    expect(dauerKurz(54_187)).toBe("54 s");
    expect(dauerKurz(12 * 60_000)).toBe("12 min");
  });

  it("Anteile ergeben zusammen 100 %, auch bei Rundung", () => {
    expect(anteile([1, 1, 1])).toEqual([34, 33, 33]);
    expect(anteile([15, 6, 3])).toEqual([63, 25, 12]);
    expect(anteile([0, 0, 0])).toEqual([0, 0, 0]);
    expect(anteile([2, 0, 0])).toEqual([100, 0, 0]);
    expect(pct(0.45)).toBe("45 %");
    expect(pct(0.683)).toBe("68 %");
  });
});
