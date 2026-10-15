import { describe, expect, it } from "vitest";
import { anteile, belegText, dauerKurz, pct, seitenText } from "./leistung-teil";

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

  it("Rechenzeit je Seite und Groesse einer Auftragsart: nur was da ist, ein Teil/eine Seite ohne Angabe", () => {
    expect(seitenText({ art: "nacht_zz", n: 3, ok: 3, ms_seite_text: 1830, ms_seite_gescannt: 4100, seiten_max: 22, teile_max: 7 }))
      .toBe("je Seite 1,8 s Text, 4,1 s gescannt · bis 22 Seiten in bis zu 7 Teilen gelesen");
    expect(seitenText({ art: "ablage_analyse", n: 1, ok: 1, ms_seite_text: 900, seiten_max: 1, teile_max: 1 })).toBe("je Seite 0,9 s Text");
    expect(seitenText({ art: "nas_suche", n: 4, ok: 4 })).toBe("");
  });
});

describe("Belegquote", () => {
  it("Beschrieb gesamt und je Feld, Fristen getrennt, mit «wie gemessen»", () => {
    const t = belegText({ zz: 40, fristen: 21, felder: { datum: { angegeben: 20, belegt: 18 }, status: { angegeben: 5, belegt: 4 }, fristen: { angegeben: 6, belegt: 5 } } });
    expect(t.wert).toBe("88 % belegt");
    expect(t.wie).toContain("22 von 25 Angaben im Beschrieb belegt (40 Dateien) — Datum 90 %, Status 80 %");
    expect(t.wie).toContain("Fristen 5 von 6 belegt (21 Dokumente)");
    expect(t.wie).toContain("wörtlich im gelesenen Teil");
  });
  it("nur Fristen, oder noch keine Messung", () => {
    expect(belegText({ zz: 0, fristen: 3, felder: { fristen: { angegeben: 4, belegt: 1 } } }).wert).toBe("25 % der Fristen belegt");
    expect(belegText(undefined).wert).toBe("noch keine");
    expect(belegText({ zz: 2, fristen: 0, felder: {} }).wert).toBe("noch keine");
  });
});
