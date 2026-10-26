import { describe, expect, it } from "vitest";
import { bezeichnungSchluessel, gruppenNummernText, technikGesamtliste } from "@/lib/technik";

// «Pos 00» — berechnete Gesamtliste aller Einzelpositionen (Firmen-Tab + Portal).

const g = (id: string, nummer: number, titel = `Gruppe ${nummer}`) => ({ id, nummer, titel });
const p = (gruppe_id: string, menge: number, bezeichnung: string, artikel_id: string | null = null) =>
  ({ gruppe_id, menge, bezeichnung, artikel_id });

describe("technikGesamtliste", () => {
  it("zaehlt gleiche Bezeichnungen ueber Gruppen zusammen und nennt die Pos", () => {
    const r = technikGesamtliste(
      [g("c", 3), g("a", 1), g("b", 2)],
      [p("a", 2, "Shure SM58"), p("b", 1, "Stativ"), p("c", 4, "shure sm-58"), p("a", 1, "Stativ")],
    );
    expect(r.zeilen.map((z) => [z.menge, z.bezeichnung, gruppenNummernText(z.nummern)])).toEqual([
      [6, "Shure SM58", "Pos 01, 03"],
      [2, "Stativ", "Pos 01, 02"],
    ]);
    expect(r.ohneEinzelpositionen).toEqual([]);
  });

  it("gleicher Katalog-Artikel zaehlt zusammen, auch bei anderer Bezeichnung", () => {
    const r = technikGesamtliste(
      [g("a", 1), g("b", 2)],
      [p("a", 1, "Monitor aktiv", "art1"), p("b", 2, "Active Monitor", "art1")],
    );
    expect(r.zeilen).toHaveLength(1);
    expect(r.zeilen[0]).toMatchObject({ menge: 3, bezeichnung: "Monitor aktiv", nummern: [1, 2] });
  });

  it("freie Bezeichnung = Name eines Katalog-Artikels zaehlt zu diesem", () => {
    const r = technikGesamtliste(
      [g("a", 1), g("b", 2)],
      [p("a", 1, "DI-Box", "art9"), p("b", 2, "DI Box")],
    );
    expect(r.zeilen).toHaveLength(1);
    expect(r.zeilen[0].menge).toBe(3);
  });

  it("verschiedene Artikel mit gleichem Namen bleiben getrennt, freie Bezeichnung dann eigene Zeile", () => {
    const r = technikGesamtliste(
      [g("a", 1)],
      [p("a", 1, "Kabel", "k1"), p("a", 1, "Kabel", "k2"), p("a", 5, "Kabel")],
    );
    expect(r.zeilen.map((z) => z.menge)).toEqual([1, 1, 5]);
  });

  it("nennt Gruppen ohne Einzelpositionen; ignoriert Positionen fremder Gruppen", () => {
    const r = technikGesamtliste(
      [g("a", 1, "Beschallung"), g("b", 2, "Licht"), g("c", 4, "Rahmen")],
      [p("b", 2, "Scheinwerfer"), p("x", 9, "Fremd")],
    );
    expect(r.zeilen.map((z) => z.bezeichnung)).toEqual(["Scheinwerfer"]);
    expect(r.ohneEinzelpositionen).toEqual([{ nummer: 1, titel: "Beschallung" }, { nummer: 4, titel: "Rahmen" }]);
  });

  it("Pos doppelt in derselben Gruppe nur einmal nennen", () => {
    const r = technikGesamtliste([g("a", 1)], [p("a", 1, "Stativ"), p("a", 2, "Stativ ")]);
    expect(r.zeilen[0]).toMatchObject({ menge: 3, nummern: [1] });
  });
});

describe("bezeichnungSchluessel", () => {
  it("ignoriert Gross/klein, Leer- und Satzzeichen, behaelt Umlaute", () => {
    expect(bezeichnungSchluessel(" DI-Box, Mono Line ")).toBe(bezeichnungSchluessel("di box mono-line"));
    expect(bezeichnungSchluessel("Bühne 4×2 m")).toBe("bühne42m");
  });
});
