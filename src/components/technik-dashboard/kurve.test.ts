import { describe, it, expect } from "vitest";
import { GRENZ_LH, HINWEIS_LH, grenzTops, hinweisTop } from "./kurve";

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

describe("Technik-Dashboard — Hinweis «Noch keine Werte» neben Grenz-Beschriftungen", () => {
  // Befund 15.10.: in «Ein-/Auslagern» (h 64, Achse 16 MB/s) lag «10 MB/s Warnung» (unter der Linie) auf dem Hinweis.
  const trifft = (hinweis: number, grenze: number) => hinweis < grenze + GRENZ_LH + 1 && grenze < hinweis + HINWEIS_LH + 1;

  it("Auslagern-Kurve: der Hinweis weicht der Beschriftung aus und bleibt im Rahmen", () => {
    const h = 64;
    const linie = 112 - (10 / 16) * 100; // viewBox-y der 10-MB/s-Linie
    const [grenze] = grenzTops([{ yPx: (linie / 120) * h, unten: true }], h);
    const top = hinweisTop(h, [grenze]);
    expect(trifft(top, grenze)).toBe(false);
    expect(top >= 0 && top + HINWEIS_LH <= h).toBe(true);
  });

  it("ohne Grenzen oder mit freier Mitte: mittig wie bisher", () => {
    expect(hinweisTop(88, [])).toBe((88 - HINWEIS_LH) / 2);
    expect(hinweisTop(88, [4])).toBe((88 - HINWEIS_LH) / 2);
  });

  it("mehrere Beschriftungen (Temperatur-Kurve): nie auf einer, so nah an der Mitte wie moeglich", () => {
    const h = 96;
    const tops = grenzTops([{ yPx: 30 }, { yPx: 50, unten: true }], h);
    const top = hinweisTop(h, tops);
    for (const g of tops) expect(trifft(top, g)).toBe(false);
    expect(top >= 0 && top + HINWEIS_LH <= h).toBe(true);
  });

  it("kein freier Platz (winzige Flaeche): mittig statt ausserhalb", () => {
    expect(hinweisTop(20, [0, 4])).toBe(2);
  });
});
