import { describe, it, expect } from "vitest";
import { bereinigeArchivFrageErgebnis, bereinigeNasSucheErgebnis, quellenFuerAnzeige, trefferFuerAnzeige, type IndexZeile } from "./bereinigen";

// Unicode-Faelle (MASTERPLAN §3.0): Rig meldet NFC, der Index speichert die
// Bytes der Platte (vom Mac oft NFD). `index` ist so aufgebaut, wie ihn
// ladeIndexZeilenNfc liefert: NFC-Schluessel -> Zeile mit gespeichertem Pfad.
const NFC = "00_ADMIN_RECHT/03_Dauerverträge/Mietvertrag Büro.pdf".normalize("NFC");
const NFD = NFC.normalize("NFD");

function zeile(pfad: string): IndexZeile {
  return { pfad, name: pfad.slice(pfad.lastIndexOf("/") + 1), ordner_pfad: pfad.slice(0, pfad.lastIndexOf("/")), geaendert: null };
}
const indexMit = (gespeichert: string) => new Map([[gespeichert.normalize("NFC"), zeile(gespeichert)]]);

describe("quellenFuerAnzeige (Unicode)", () => {
  it("findet NFD im Index ueber den NFC-Pfad der Antwort, gibt die gespeicherte Schreibweise weiter", () => {
    expect(NFC).not.toBe(NFD);
    const aus = quellenFuerAnzeige([{ pfad: NFC, seite: 3 }], indexMit(NFD));
    expect(aus).toHaveLength(1);
    expect(aus[0].pfad).toBe(NFD);
    expect(aus[0].ordner).toBe(NFD.slice(0, NFD.lastIndexOf("/")));
    expect(aus[0].seite).toBe(3);
  });

  it("findet NFC im Index auch ueber einen NFD-Pfad der Antwort", () => {
    const aus = quellenFuerAnzeige([{ pfad: NFD, seite: null }], indexMit(NFC));
    expect(aus.map((q) => q.pfad)).toEqual([NFC]);
  });

  it("ganzer Weg: bereinigte Rig-Antwort (NFD gemeldet) + NFD im Index -> alle Quellen", () => {
    const e = bereinigeArchivFrageErgebnis({ antwort: "x", quellen: [{ pfad: NFD, seite: 1 }, { pfad: "a/b.pdf", seite: 2 }] });
    const index = new Map([...indexMit(NFD), ...indexMit("a/b.pdf")]);
    expect(quellenFuerAnzeige(e!.quellen, index).map((q) => q.pfad)).toEqual([NFD, "a/b.pdf"]);
  });

  it("laesst Pfade ausserhalb des Index und 99_System weg", () => {
    const index = new Map([...indexMit("99_System/x.pdf")]);
    expect(quellenFuerAnzeige([{ pfad: "99_System/x.pdf", seite: null }, { pfad: "fehlt.pdf", seite: null }], index)).toEqual([]);
  });
});

describe("trefferFuerAnzeige (Unicode)", () => {
  it("findet NFD im Index ueber den NFC-Treffer und umgekehrt, Pfad = gespeicherte Schreibweise", () => {
    expect(trefferFuerAnzeige([{ pfad: NFC, seite: 1, score: 0.5 }], indexMit(NFD)).map((t) => t.pfad)).toEqual([NFD]);
    expect(trefferFuerAnzeige([{ pfad: NFD, seite: 1, score: 0.5 }], indexMit(NFC)).map((t) => t.pfad)).toEqual([NFC]);
  });
});

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
