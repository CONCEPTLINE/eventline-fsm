import { describe, expect, it } from "vitest";
import { fassungAusMomentaufnahme, jahresliste, type FassungFuerListe, type MomentaufnahmeFuerListe } from "./jahresliste";

const P = "p1";
function f(o: Partial<FassungFuerListe> & Pick<FassungFuerListe, "jahr" | "monat" | "fassung" | "auszahlungsdatum">): FassungFuerListe {
  return {
    profile_id: P, art: "regulaer", im_papierkorb: false, brutto: 1000, netto: 920, ahv_lohn: 1000, alv_lohn: 1000, uvg_lohn: 1000,
    uvg_art: "bu", quellensteuer: 0, lohnperiode: null,
    steuerbar: o.brutto ?? 1000, zusatz_steuerbar: 0, zusatz_texte: [], spesen: 0, spesen_texte: [], auszahlungsbetrag: o.netto ?? 920,
    abzug_ahv_iv_eo: 53, abzug_alv: 11, abzug_nbu: 16, abzug_bvg: 0, abzug_ktg: 0, ...o,
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
  it("Phase 4: Zusatzposten, Spesen und Abzüge je Art — Korrektur-Differenz im Jahr ihrer Auszahlung", () => {
    const liste = [
      f({ jahr: 2026, monat: 11, fassung: 1, auszahlungsdatum: "2026-12-07" }),
      f({
        jahr: 2026, monat: 11, fassung: 2, art: "korrektur", auszahlungsdatum: "2027-01-08",
        brutto: 1100, steuerbar: 1100, zusatz_steuerbar: 100, zusatz_texte: ["Quellensteuer vom Arbeitgeber bezahlt"],
        spesen: 40, spesen_texte: ["Verpflegung"], netto: 1000, auszahlungsbetrag: 1040, abzug_ahv_iv_eo: 58.3,
      }),
    ];
    const z26 = jahresliste(liste, { jahr: 2026, basis: "auszahlung", ahvVerlangt: nie })[0];
    const z27 = jahresliste(liste, { jahr: 2027, basis: "auszahlung", ahvVerlangt: nie })[0];
    expect(z26.zusatz_steuerbar).toBe(0);
    expect(z26.zusatz_texte).toEqual([]);
    expect(z26.auszahlungsbetrag).toBe(920);
    expect(z27.zusatz_steuerbar).toBe(100);
    expect(z27.zusatz_texte).toEqual(["Quellensteuer vom Arbeitgeber bezahlt"]);
    expect(z27.spesen).toBe(40);
    expect(z27.spesen_texte).toEqual(["Verpflegung"]);
    expect(z27.auszahlungsbetrag).toBe(120);
    expect(z27.abzug_ahv_iv_eo).toBe(5.3);
  });
  it("Momentaufnahme → Fassung: Altbestand ohne Zusatzposten, Rückerstattung netto, ohne Abzüge = Fehler", () => {
    const basis: MomentaufnahmeFuerListe = {
      profile_id: P, jahr: 2026, monat: 5, fassung: 1, art: "altbestand", auszahlungsdatum: "2026-06-08", im_papierkorb: false,
      brutto: "500.00", netto: "467.95", auszahlungsbetrag: null, ahv_lohn: "500.00", alv_lohn: "500.00", uvg_lohn: "500.00", uvg_art: "bu",
      quellensteuer: "0", lohnperiode: null, abzuege: [{ art: "ahv_iv_eo", betrag: 26.5 }, { art: "alv", betrag: 5.55 }], zusatzposten: null, steuerbar: null, spesen: null,
    };
    const alt = fassungAusMomentaufnahme(basis);
    expect(alt).toMatchObject({ steuerbar: 500, zusatz_steuerbar: 0, spesen: 0, auszahlungsbetrag: 467.95, abzug_ahv_iv_eo: 26.5, abzug_alv: 5.55, abzug_nbu: 0 });
    const neu = fassungAusMomentaufnahme({
      ...basis, art: "regulaer", auszahlungsbetrag: "498.40", steuerbar: 600, spesen: 30.45,
      abzuege: [{ art: "ahv_iv_eo", betrag: 31.8 }, { art: "ahv_iv_eo", betrag: -26.5 }],
      zusatzposten: [{ art: "lohn", bezeichnung: "Bonus", betrag: 100, steuerbar: true }, { art: "spesen", bezeichnung: "Material", betrag: 30.45, steuerbar: false }],
    });
    expect(neu).toMatchObject({ steuerbar: 600, zusatz_steuerbar: 100, zusatz_texte: ["Bonus"], spesen: 30.45, spesen_texte: ["Material"], auszahlungsbetrag: 498.4, abzug_ahv_iv_eo: 5.3 });
    expect(() => fassungAusMomentaufnahme({ ...basis, abzuege: null })).toThrow(/Abzüge/);
  });
});
