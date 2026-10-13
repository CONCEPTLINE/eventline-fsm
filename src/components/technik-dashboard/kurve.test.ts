import { describe, it, expect } from "vitest";
import { GRENZ_LH, grenzTops } from "./kurve";

// Grenz-Beschriftungen der Kurven: nie ueber den Rand, nie uebereinander (Review 2026-10-14:
// «90 % kritisch» war oben abgeschnitten, «75 °C Warnung» lag unter dem Wert-Label).
const ueberlappt = (a: number, b: number) => a < b + GRENZ_LH && b < a + GRENZ_LH;

describe("Technik-Dashboard — Grenz-Beschriftungen", () => {
  it("Linie nah am oberen Rand: Beschriftung unter die Linie statt abgeschnitten", () => {
    const [top] = grenzTops([{ yPx: 10 }], 56);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBe(12);
  });

  it("zwei nahe Linien (NAS 80/90 %): beide sichtbar, ohne Ueberlappung, im Rahmen", () => {
    const h = 56;
    const tops = grenzTops([{ yPx: 15 }, { yPx: 10.3 }], h);
    for (const t of tops) expect(t >= 0 && t + GRENZ_LH <= h).toBe(true);
    expect(ueberlappt(tops[0], tops[1])).toBe(false);
  });

  it("Linien mit Abstand: Beschriftung oberhalb der Linie wie bisher", () => {
    const tops = grenzTops([{ yPx: 20 }, { yPx: 60 }], 88);
    expect(tops).toEqual([20 - GRENZ_LH - 2, 60 - GRENZ_LH - 2]);
  });

  it("«unten» bevorzugt unter der Linie, am unteren Rand oberhalb", () => {
    expect(grenzTops([{ yPx: 30, unten: true }], 88)).toEqual([32]);
    expect(grenzTops([{ yPx: 84, unten: true }], 88)).toEqual([84 - GRENZ_LH - 2]);
  });

  it("drei Linien dicht am unteren Rand: keine Ueberlappung, nie ueber den Rand", () => {
    const h = 64;
    const tops = grenzTops([{ yPx: 50 }, { yPx: 56 }, { yPx: 60 }], h);
    for (const t of tops) expect(t >= 0 && t + GRENZ_LH <= h).toBe(true);
    expect(ueberlappt(tops[0], tops[1]) || ueberlappt(tops[1], tops[2]) || ueberlappt(tops[0], tops[2])).toBe(false);
  });
});
