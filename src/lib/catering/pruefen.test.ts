import { describe, expect, it } from "vitest";
import { pruefeStammdaten, type EinstellungenEingabe, type KartenEingabe } from "./pruefen";

const E: EinstellungenEingabe = { lohnProStunde: 32, gaesteProKraft: 50, puffer: 0.1, stundensatzA: 45, anteilVor: 0.85, rateVor: 1.2, anteilPause: 0.9, ratePause: 3, anteilNach: 0.65, rateNach: 1.2 };
const zeile = (o: Partial<KartenEingabe> = {}): KartenEingabe => ({ kategorie: "bier", name: "Birra", einheit: "33 cl", verkauf: 6.5, einkauf: 1.85, mixAnteil: 1, aktiv: true, ...o });

describe("pruefeStammdaten", () => {
  it("akzeptiert gültige Werte", () => {
    expect(pruefeStammdaten(E, [zeile({ mixAnteil: 0.6 }), zeile({ kategorie: "softdrink", name: "Eptinger", mixAnteil: 0.4 })])).toBeNull();
  });
  it("verlangt genau 100 % Mix bei aktiven Zeilen", () => {
    expect(pruefeStammdaten(E, [zeile({ mixAnteil: 0.5 })])).toMatch(/50 %/);
    expect(pruefeStammdaten(E, [zeile({ mixAnteil: 0.5 }), zeile({ name: "x", mixAnteil: 0.5, aktiv: false }), zeile({ name: "y", mixAnteil: 0.5 })])).toBeNull();
  });
  it("lehnt unbekannte Kategorie, leeren Namen und negative Preise ab", () => {
    expect(pruefeStammdaten(E, [zeile({ kategorie: "spirituosen" })])).toMatch(/Kategorie/);
    expect(pruefeStammdaten(E, [zeile({ name: "  " })])).toMatch(/Namen/);
    expect(pruefeStammdaten(E, [zeile({ verkauf: -1 })])).toMatch(/Preise/);
  });
  it("lehnt ungültige Einstellungen ab", () => {
    expect(pruefeStammdaten({ ...E, gaesteProKraft: 0 }, [zeile()])).toMatch(/Gäste pro Servicekraft/);
    expect(pruefeStammdaten({ ...E, anteilPause: 1.5 }, [zeile()])).toMatch(/Anteil der Trinkenden/);
    expect(pruefeStammdaten({ ...E, lohnProStunde: -5 }, [zeile()])).toMatch(/Personalkosten/);
  });
  it("lehnt eine leere Karte ab", () => {
    expect(pruefeStammdaten(E, [])).toMatch(/leer/);
  });
});
