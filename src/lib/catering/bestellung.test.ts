import { describe, expect, it } from "vitest";
import { bestellungAlsText, erstelleBestellung, leseMass } from "./bestellung";
import type { KartenZeile } from "./daten";

const z = (n: number, o: Partial<KartenZeile>): KartenZeile => ({ id: `i${n}`, kategorie: "bier", name: `G${n}`, einheit: "33 cl", verkauf: 6, einkauf: 2, mixAnteil: null, ...o });
// Karte Stand 02.11.2026 mit den Anteilen aus Migration 375 (Bier 28 + 7, Softdrinks 10 + 10 + 10 + 5, Wein je 10, Aperol 10)
const KARTE: KartenZeile[] = [
  z(1, { kategorie: "aperitif", name: "Aperol Spritz", einheit: "20 cl", mixAnteil: 0.1 }),
  z(2, { kategorie: "weisswein", name: "Terravin", einheit: "Glas · 1 dl", mixAnteil: 0.1 }),
  z(3, { kategorie: "weisswein", name: "Terravin", einheit: "Flasche · 75 cl", mixAnteil: null }),
  z(4, { kategorie: "rotwein", name: "Pinot Noir", einheit: "Glas · 1 dl", mixAnteil: 0.1 }),
  z(5, { kategorie: "rotwein", name: "Pinot Noir", einheit: "Flasche · 75 cl", mixAnteil: null }),
  z(6, { kategorie: "bier", name: "Birra Moretti", einheit: "33 cl", mixAnteil: 0.28 }),
  z(7, { kategorie: "bier", name: "Birra Moretti, alkoholfrei", einheit: "33 cl", mixAnteil: 0.07 }),
  z(8, { kategorie: "softdrink", name: "Eptinger rot", einheit: "mit Kohlensäure · 33 cl", mixAnteil: 0.1 }),
  z(9, { kategorie: "softdrink", name: "Eptinger blau", einheit: "ohne Kohlensäure · 33 cl", mixAnteil: 0.1 }),
  z(10, { kategorie: "softdrink", name: "Coca-Cola", einheit: "33 cl", mixAnteil: 0.1 }),
  z(11, { kategorie: "softdrink", name: "Coca-Cola Zero", einheit: "33 cl", mixAnteil: 0.05 }),
];

describe("leseMass", () => {
  it("erkennt Glas, Flasche und Volumen", () => {
    expect(leseMass("Glas · 1 dl")).toEqual({ typ: "glas", cl: 10 });
    expect(leseMass("Flasche · 75 cl")).toEqual({ typ: "flasche", cl: 75 });
    expect(leseMass("20 cl")).toEqual({ typ: "andere", cl: 20 });
    expect(leseMass("0,5 l")).toEqual({ typ: "andere", cl: 50 });
    expect(leseMass("")).toEqual({ typ: "andere", cl: null });
  });
});

describe("erstelleBestellung (255.15 Getränke wie INT-26404)", () => {
  const b = erstelleBestellung(KARTE, 255.15, 0.1);
  const finde = (name: string) => b.find((x) => x.name === name)!;
  it("Bier und Softdrinks nach Anteil, aufgerundet", () => {
    expect(finde("Birra Moretti").menge).toBe(72); // 255.15 × 0.28 = 71.4
    expect(finde("Birra Moretti, alkoholfrei").menge).toBe(18); // 17.9
    expect(finde("Eptinger rot").menge).toBe(26); // 25.5
    expect(finde("Coca-Cola Zero").menge).toBe(13); // 12.8
  });
  it("Wein: Gläser werden zu Flaschen (7.5 Gläser pro 75-cl-Flasche)", () => {
    const w = finde("Terravin");
    expect(w.zaehleinheit).toBe("Flaschen");
    expect(w.menge).toBe(4); // 25.5 Gläser ÷ 7.5 = 3.4
    expect(w.mengeMitReserve).toBe(4); // 28.1 ÷ 7.5 = 3.7
    expect(w.einheit).toBe("Flasche · 75 cl");
  });
  it("Aperol als Spritz mit Zutatenhinweis; keine Zeile für Flaschen ohne Mix", () => {
    expect(finde("Aperol Spritz").zaehleinheit).toBe("Spritz");
    expect(finde("Aperol Spritz").hinweis).toContain("Prosecco");
    expect(b.filter((x) => x.name === "Terravin")).toHaveLength(1);
  });
  it("Reserve erhöht die Menge, nie darunter", () => {
    for (const x of b) expect(x.mengeMitReserve).toBeGreaterThanOrEqual(x.menge);
    expect(finde("Birra Moretti").mengeMitReserve).toBe(79); // 71.4 × 1.1 = 78.5
  });
  it("Reihenfolge wie auf der Karte: Aperitif, Weisswein, Rotwein, Bier, Softdrinks", () => {
    expect(b.map((x) => x.kategorie)).toEqual(["aperitif", "weisswein", "rotwein", "bier", "bier", "softdrink", "softdrink", "softdrink", "softdrink"]);
  });
  it("Summe der Gläser/Stück entspricht der Gesamtmenge (ohne Aufrunden)", () => {
    const summe = KARTE.reduce((s, k) => s + (k.mixAnteil ?? 0), 0);
    expect(summe).toBeCloseTo(1, 6);
  });
});

describe("Randfälle", () => {
  it("Wein ohne Flaschen-Zeile bleibt in Gläsern", () => {
    const nurGlas = KARTE.filter((k) => k.id !== "i3");
    const w = erstelleBestellung(nurGlas, 100).find((x) => x.name === "Terravin")!;
    expect(w.zaehleinheit).toBe("Gläser");
    expect(w.menge).toBe(10);
  });
  it("0 Getränke ergibt Mengen von 0", () => {
    for (const x of erstelleBestellung(KARTE, 0)) expect(x.menge).toBe(0);
  });
  it("Text zum Kopieren", () => {
    const t = bestellungAlsText(erstelleBestellung(KARTE, 255.15, 0.1), false);
    expect(t).toContain("72 Stück Birra Moretti (33 cl)");
    expect(t).toContain("4 Flaschen Terravin (Flasche · 75 cl)");
  });
});
