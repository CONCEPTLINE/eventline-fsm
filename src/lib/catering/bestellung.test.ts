import { describe, expect, it } from "vitest";
import { bestellungAlsText, erstelleBestellung, leseMass } from "./bestellung";
import type { KartenZeile } from "./daten";

const z = (n: number, o: Partial<KartenZeile>): KartenZeile => ({ id: `i${n}`, kategorie: "bier", name: `G${n}`, einheit: "33 cl", verkauf: 6, einkauf: 2, mixAnteil: null, ...o });
// Karte Stand 02.11.2026 mit Mix und Gebinden aus Migration 375 (Bier 40, Softdrinks 20, Wein 25, Aperol 15)
const H = { gebindeStueck: 24, gebindeName: "Harass" };
const KARTE: KartenZeile[] = [
  z(1, { kategorie: "aperitif", name: "Aperol Spritz", einheit: "20 cl", mixAnteil: 0.15 }),
  z(2, { kategorie: "weisswein", name: "Terravin", einheit: "Glas · 1 dl", mixAnteil: 0.125 }),
  z(3, { kategorie: "weisswein", name: "Terravin", einheit: "Flasche · 75 cl", mixAnteil: null, gebindeStueck: 6, gebindeName: "Karton" }),
  z(4, { kategorie: "rotwein", name: "Pinot Noir", einheit: "Glas · 1 dl", mixAnteil: 0.125 }),
  z(5, { kategorie: "rotwein", name: "Pinot Noir", einheit: "Flasche · 75 cl", mixAnteil: null, gebindeStueck: 6, gebindeName: "Karton" }),
  z(6, { kategorie: "bier", name: "Birra Moretti", einheit: "33 cl", mixAnteil: 0.32, ...H }),
  z(7, { kategorie: "bier", name: "Birra Moretti, alkoholfrei", einheit: "33 cl", mixAnteil: 0.08, ...H }),
  z(8, { kategorie: "softdrink", name: "Eptinger rot", einheit: "mit Kohlensäure · 33 cl", mixAnteil: 0.06, ...H }),
  z(9, { kategorie: "softdrink", name: "Eptinger blau", einheit: "ohne Kohlensäure · 33 cl", mixAnteil: 0.06, ...H }),
  z(10, { kategorie: "softdrink", name: "Coca-Cola", einheit: "33 cl", mixAnteil: 0.06, ...H }),
  z(11, { kategorie: "softdrink", name: "Coca-Cola Zero", einheit: "33 cl", mixAnteil: 0.02, ...H }),
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
    expect(finde("Birra Moretti").menge).toBe(82); // 255.15 × 0.32 = 81.7
    expect(finde("Birra Moretti, alkoholfrei").menge).toBe(21); // 20.4
    expect(finde("Eptinger rot").menge).toBe(16); // 15.3
    expect(finde("Coca-Cola Zero").menge).toBe(6); // 5.1
  });
  it("Wein: Gläser werden zu Flaschen (7.5 Gläser pro 75-cl-Flasche)", () => {
    const w = finde("Terravin");
    expect(w.zaehleinheit).toBe("Flaschen");
    expect(w.menge).toBe(5); // 31.9 Gläser ÷ 7.5 = 4.3
    expect(w.mengeMitReserve).toBe(5); // 35.1 ÷ 7.5 = 4.7
    expect(w.einheit).toBe("Flasche · 75 cl");
  });
  it("Aperol als Spritz mit Zutatenhinweis; keine Zeile für Flaschen ohne Mix", () => {
    expect(finde("Aperol Spritz").zaehleinheit).toBe("Spritz");
    expect(finde("Aperol Spritz").hinweis).toContain("Prosecco");
    expect(b.filter((x) => x.name === "Terravin")).toHaveLength(1);
  });
  it("Reserve erhöht die Menge, nie darunter", () => {
    for (const x of b) expect(x.mengeMitReserve).toBeGreaterThanOrEqual(x.menge);
    expect(finde("Birra Moretti").mengeMitReserve).toBe(90); // 81.7 × 1.1 = 89.8
  });
  it("Reihenfolge wie auf der Karte: Aperitif, Weisswein, Rotwein, Bier, Softdrinks", () => {
    expect(b.map((x) => x.kategorie)).toEqual(["aperitif", "weisswein", "rotwein", "bier", "bier", "softdrink", "softdrink", "softdrink", "softdrink"]);
  });
  it("Summe der Gläser/Stück entspricht der Gesamtmenge (ohne Aufrunden)", () => {
    const summe = KARTE.reduce((s, k) => s + (k.mixAnteil ?? 0), 0);
    expect(summe).toBeCloseTo(1, 6);
  });
});

describe("Gebinde (Harass à 24, Karton à 6)", () => {
  const b = erstelleBestellung(KARTE, 255.15, 0.1);
  const finde = (name: string) => b.find((x) => x.name === name)!;
  it("rundet mit Reserve auf ganze Gebinde und nennt den Überschuss", () => {
    const m = finde("Birra Moretti"); // 89.8 → 90 Stück → 4 Harass = 96
    expect([m.gebindeAnzahl, m.gebindeStueck, m.bestellStueck]).toEqual([4, 24, 96]);
    expect(m.ueberschuss).toBeCloseTo(14.4, 1); // 96 − 81.65
  });
  it("Softdrinks: wenig Menge ergibt je einen Harass", () => {
    for (const n of ["Eptinger rot", "Eptinger blau", "Coca-Cola", "Coca-Cola Zero", "Birra Moretti, alkoholfrei"]) expect(finde(n).gebindeAnzahl).toBe(1);
  });
  it("Wein: Gebinde der Flasche zählt (Karton à 6)", () => {
    const w = finde("Terravin");
    expect([w.gebindeName, w.gebindeAnzahl, w.bestellStueck]).toEqual(["Karton", 1, 6]);
  });
  it("Aperol ohne Gebinde bleibt einzeln", () => {
    const a = finde("Aperol Spritz");
    expect([a.gebindeAnzahl, a.bestellStueck]).toEqual([null, a.mengeMitReserve]);
  });
  it("0 Getränke ergibt 0 Gebinde", () => {
    for (const x of erstelleBestellung(KARTE, 0)) expect(x.bestellStueck).toBe(0);
  });
});

describe("Randfälle", () => {
  it("Wein ohne Flaschen-Zeile bleibt in Gläsern", () => {
    const nurGlas = KARTE.filter((k) => k.id !== "i3");
    const w = erstelleBestellung(nurGlas, 100).find((x) => x.name === "Terravin")!;
    expect(w.zaehleinheit).toBe("Gläser");
    expect(w.menge).toBe(13); // 12.5 Gläser
  });
  it("0 Getränke ergibt Mengen von 0", () => {
    for (const x of erstelleBestellung(KARTE, 0)) expect(x.menge).toBe(0);
  });
  it("Text zum Kopieren", () => {
    const t = bestellungAlsText(erstelleBestellung(KARTE, 255.15, 0.1), true);
    expect(t).toContain("4 Harass à 24 Birra Moretti (33 cl) = 96 Stück");
    expect(t).toContain("1 Karton à 6 Terravin (Flasche · 75 cl) = 6 Flaschen");
  });
});
