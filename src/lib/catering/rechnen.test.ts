import { describe, expect, it } from "vitest";
import { aufrunden10, CATERING_STANDARD, mixDurchschnitt, rechneCatering, type CateringEingabe, type MixZeile } from "./rechnen";

// Karte Stand 02.11.2026 (Rupp-Weine): Bier 35 %, Softdrinks 35 %, Weisswein 10 %, Rotwein 10 %, Aperol 10 %.
const KARTE: MixZeile[] = [
  { einkauf: 1.85, verkauf: 6.5, mixAnteil: 0.35 },
  { einkauf: 1.2, verkauf: 5.5, mixAnteil: 0.35 },
  { einkauf: 18.5 / 7.5, verkauf: 8, mixAnteil: 0.1 },
  { einkauf: 17.9 / 7.5, verkauf: 8, mixAnteil: 0.1 },
  { einkauf: 2.6, verkauf: 8, mixAnteil: 0.1 },
  { einkauf: 1.85, verkauf: 6.5, mixAnteil: null }, // nicht im Mix (z. B. alkoholfreies Bier)
];

// INT-26404: 90 Gäste, 60 Min. Aufbau, 215 Min. Veranstaltung, 30 Min. Abbau, 45/20/90 Min. Ausschank.
const INT_26404: CateringEingabe = { gaeste: 90, aufbauMin: 60, gesamtMin: 215, abbauMin: 30, vorzeitMin: 45, pauseMin: 20, nachzeitMin: 90 };

describe("aufrunden10", () => {
  it("rundet auf CHF 10 auf und ist gegen Gleitkomma-Reste geschützt", () => {
    expect(aufrunden10(866.66)).toBe(870);
    expect(aufrunden10(870)).toBe(870);
    expect(aufrunden10(870.0000001)).toBe(870);
    expect(aufrunden10(870.01)).toBe(880);
  });
});

describe("mixDurchschnitt", () => {
  it("gewichtet Einkauf und Verkauf nach Anteil", () => {
    const m = mixDurchschnitt(KARTE);
    expect(m.einkauf).toBeCloseTo(1.8128, 3);
    expect(m.verkauf).toBeCloseTo(6.6, 3);
  });
  it("verlangt 100 % Mix", () => {
    expect(() => mixDurchschnitt([{ einkauf: 1, verkauf: 2, mixAnteil: 0.5 }])).toThrow();
  });
});

describe("rechneCatering (INT-26404: B 870, A-Richtwert 2180)", () => {
  const r = rechneCatering(INT_26404, CATERING_STANDARD, KARTE);
  it("Getränke je Phase und gesamt", () => {
    expect(r.getraenkeVor).toBeCloseTo(68.85, 2);
    expect(r.getraenkePause).toBeCloseTo(81, 2);
    expect(r.getraenkeNach).toBeCloseTo(105.3, 2);
    expect(r.getraenke).toBeCloseTo(255.15, 2);
    expect(r.bestellmengeA).toBe(260);
  });
  it("Personal: 2 Kräfte, 5.08 Std, CHF 32", () => {
    expect(r.kraefte).toBe(2);
    expect(r.stundenProKraft).toBeCloseTo(5.0833, 3);
    expect(r.personal).toBeCloseTo(325.33, 2);
  });
  it("Kosten und die zwei Preise", () => {
    expect(r.einkauf).toBeCloseTo(462.54, 2);
    expect(r.kosten).toBeCloseTo(787.88, 2);
    expect(r.puffer).toBeCloseTo(78.79, 2);
    expect(r.mindestumsatz).toBe(870);
    expect(r.getraenkeA).toBe(1720); // 260 Getränke × Ø 6.60, auf CHF 10 aufgerundet
    expect(r.serviceA).toBe(460); // 2 Kräfte × 5.083 Std × CHF 45 = 457.50, auf CHF 10 aufgerundet
    expect(r.richtpreisA).toBe(2180);
  });
  it("Umsatz, Differenz bei halber Menge und Gewinn", () => {
    expect(r.erwarteterUmsatz).toBeCloseTo(1683.99, 2);
    expect(r.differenzBeiHalberMenge).toBeCloseTo(28.01, 2);
    expect(r.gewinnA).toBeCloseTo(1383.33, 2); // 2180 − (260 × Ø Einkauf 1.8128 + Personal 325.33)
    expect(r.gewinnB).toBeCloseTo(896.11, 2);
    expect(r.stundensatzA).toBe(45);
  });
});

describe("Servicekräfte: 1 bis 49 Gäste, ab 50 zwei, ab 100 drei", () => {
  const kraefte = (gaeste: number) => rechneCatering({ ...INT_26404, gaeste }, CATERING_STANDARD, KARTE).kraefte;
  it("Schwellen", () => {
    expect(kraefte(49)).toBe(1);
    expect(kraefte(50)).toBe(2);
    expect(kraefte(99)).toBe(2);
    expect(kraefte(100)).toBe(3);
  });
});

describe("Randfälle", () => {
  it("0 Gäste ergibt keine Getränke, aber Personalkosten für 1 Kraft", () => {
    const r = rechneCatering({ ...INT_26404, gaeste: 0 }, CATERING_STANDARD, KARTE);
    expect(r.getraenke).toBe(0);
    expect(r.getraenkeProGast).toBe(0);
    expect(r.kraefte).toBe(1);
  });
  it("negative Minuten zählen nicht", () => {
    const r = rechneCatering({ ...INT_26404, vorzeitMin: -10 }, CATERING_STANDARD, KARTE);
    expect(r.getraenkeVor).toBe(0);
  });
});
