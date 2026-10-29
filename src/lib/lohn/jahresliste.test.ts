import { describe, expect, it } from "vitest";
import { jahresliste, type FassungFuerListe } from "./jahresliste";

const P = "p1";
function f(o: Partial<FassungFuerListe> & Pick<FassungFuerListe, "jahr" | "monat" | "fassung" | "auszahlungsdatum">): FassungFuerListe {
  return {
    profile_id: P, art: "regulaer", im_papierkorb: false, brutto: 1000, netto: 920, ahv_lohn: 1000, alv_lohn: 1000, uvg_lohn: 1000,
    uvg_art: "bu", quellensteuer: 0, lohnperiode: null, ...o,
  };
}
const nie = () => false;

describe("Jahresliste", () => {
  it("nur die letzte Fassung zählt; Korrektur-Differenz im Jahr ihrer Auszahlung", () => {
    const liste = [
      f({ jahr: 2026, monat: 11, fassung: 1, art: "altbestand", auszahlungsdatum: "2026-12-07" }),
      f({ jahr: 2026, monat: 11, fassung: 2, art: "korrektur", auszahlungsdatum: "2027-01-08", brutto: 1100, netto: 1010, ahv_lohn: 1100, alv_lohn: 1100, uvg_lohn: 1100 }),
    ];
    const z2026 = jahresliste(liste, { jahr: 2026, basis: "auszahlung", ahvVerlangt: nie });
    const z2027 = jahresliste(liste, { jahr: 2027, basis: "auszahlung", ahvVerlangt: nie });
    expect(z2026).toHaveLength(1);
    expect(z2026[0].ahv_lohn).toBe(1000);
    expect(z2027[0].ahv_lohn).toBe(100);
    const arbeit = jahresliste(liste, { jahr: 2026, basis: "arbeit", ahvVerlangt: nie });
    expect(arbeit.reduce((s, z) => s + z.ahv_lohn, 0)).toBe(1100);
  });
  it("Dezember-Lohn mit Auszahlung im Januar gehört ins Folgejahr", () => {
    const z = jahresliste([f({ jahr: 2026, monat: 12, fassung: 1, auszahlungsdatum: "2027-01-08" })], { jahr: 2027, basis: "auszahlung", ahvVerlangt: nie });
    expect(z).toHaveLength(1);
    expect(z[0].arbeitsjahr).toBe(2026);
  });
  it("2'500-Grenze: ganzer AHV-Lohn beitragsfrei, ausser verlangt", () => {
    const liste = [f({ jahr: 2026, monat: 3, fassung: 1, auszahlungsdatum: "2026-04-08" }), f({ jahr: 2026, monat: 4, fassung: 1, auszahlungsdatum: "2026-05-08" })];
    expect(jahresliste(liste, { jahr: 2026, basis: "auszahlung", ahvVerlangt: nie }).every((z) => z.ahv_beitragsfrei === z.ahv_lohn)).toBe(true);
    expect(jahresliste(liste, { jahr: 2026, basis: "auszahlung", ahvVerlangt: () => true }).every((z) => z.ahv_beitragsfrei === 0)).toBe(true);
    const viel = [...liste, f({ jahr: 2026, monat: 5, fassung: 1, auszahlungsdatum: "2026-06-08" })];
    expect(jahresliste(viel, { jahr: 2026, basis: "auszahlung", ahvVerlangt: nie }).every((z) => z.ahv_beitragsfrei === 0)).toBe(true);
  });
  it("UVG nur BU bzw. BU+NBU; Wechsel durch Korrektur", () => {
    const liste = [
      f({ jahr: 2026, monat: 6, fassung: 1, art: "altbestand", auszahlungsdatum: "2026-07-07", uvg_art: "bu_nbu" }),
      f({ jahr: 2026, monat: 6, fassung: 2, art: "korrektur", auszahlungsdatum: "2026-12-07", uvg_art: "bu" }),
    ];
    const z = jahresliste(liste, { jahr: 2026, basis: "auszahlung", ahvVerlangt: nie });
    expect(z[0].uvg_lohn_bu_nbu).toBe(0);
    expect(z[0].uvg_lohn_nur_bu).toBe(1000);
  });
  it("Papierkorb zählt nicht", () => {
    expect(jahresliste([f({ jahr: 2026, monat: 3, fassung: 1, auszahlungsdatum: "2026-04-08", im_papierkorb: true })], { jahr: 2026, basis: "auszahlung", ahvVerlangt: nie })).toHaveLength(0);
  });
});
