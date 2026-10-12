import { describe, it, expect } from "vitest";
import { bereinigeNasSucheErgebnis } from "./bereinigen";

describe("bereinigeNasSucheErgebnis", () => {
  const basis = { treffer: [{ pfad: "02_LOCATIONS/a.pdf", seite: 2, score: 0.7, text: "geheim" }], index: { dateien: 449, gelesen_anteil: 1 }, dauer_ms: 42 };

  it("uebernimmt modus «volltext» und «kombiniert»", () => {
    expect(bereinigeNasSucheErgebnis({ ...basis, modus: "volltext" })?.modus).toBe("volltext");
    expect(bereinigeNasSucheErgebnis({ ...basis, modus: "kombiniert" })?.modus).toBe("kombiniert");
  });

  it("laesst unbekannten oder fehlenden modus weg", () => {
    expect(bereinigeNasSucheErgebnis({ ...basis, modus: "egal" })).not.toHaveProperty("modus");
    expect(bereinigeNasSucheErgebnis({ ...basis, modus: 1 })).not.toHaveProperty("modus");
    expect(bereinigeNasSucheErgebnis(basis)).not.toHaveProperty("modus");
  });

  it("gibt nie Text weiter, nur pfad/seite/score", () => {
    const e = bereinigeNasSucheErgebnis({ ...basis, modus: "volltext" });
    expect(e?.treffer).toEqual([{ pfad: "02_LOCATIONS/a.pdf", seite: 2, score: 0.7 }]);
    expect(Object.keys(e ?? {}).sort()).toEqual(["dauer_ms", "index", "modus", "treffer"]);
  });
});
