import { describe, expect, it } from "vitest";
import { fristSchluesselPfad, pruefeNachtarbeit, sachverhalteDerEingabe, type NachtarbeitDaten, type NachtarbeitEingabe } from "./nachtarbeit";
import { sachSchluessel } from "./fristen-sachverhalt";

// Fristen-Teil der Nachtarbeit: dieselbe Frist aus mehreren Dateien
// (Vertrag als .docx und .pdf, Entwurf und Historie-Kopie) wird EINE Zeile.

const ORDNER = "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/01_Entwuerfe";
const DATEIEN = [`${ORDNER}/V02.docx`, `${ORDNER}/V02.pdf`, `${ORDNER}/Historie/V.docx`, `${ORDNER}/Historie/V.pdf`];
const BED = { ende: "2027-12-31", kuendigungsfrist: { anzahl: 6, einheit: "monate" } };

function daten(p: Partial<NachtarbeitDaten> = {}): NachtarbeitDaten {
  const index = new Map(DATEIEN.map((pfad) => [pfad, { pfad, ordner_pfad: pfad.slice(0, pfad.lastIndexOf("/")), name: pfad.slice(pfad.lastIndexOf("/") + 1) }]));
  index.set("ZZ_Dokumente/bilanz.pdf", { pfad: "ZZ_Dokumente/bilanz.pdf", ordner_pfad: "ZZ_Dokumente", name: "bilanz.pdf" });
  index.set("06_PERSONAL/1001/Vertrag.pdf", { pfad: "06_PERSONAL/1001/Vertrag.pdf", ordner_pfad: "06_PERSONAL/1001", name: "Vertrag.pdf" });
  return {
    heute: "2026-10-14",
    ordnerAktiv: new Map(),
    namen: [],
    index,
    offen: new Map(),
    ausstehend: new Set(),
    abgelehnt: new Set(),
    fristen: new Set(),
    sachverhalte: new Map(),
    itemJePfad: new Map(),
    itemsJeSha: new Map(),
    ...p,
  };
}

const frist = (pfad: string, partei: string | null = "Verein SCALA BASEL", art = "kuendigung") => ({ pfad, art, bedingungen: BED, partei, sicherheit: "hoch" });
const eingabe = (fristen: unknown[]): NachtarbeitEingabe => ({ lauf_id: null, modell: null, vorschlaege: [], fristen });

describe("Nachtarbeit: gleiche Frist aus mehreren Dateien", () => {
  it("vier Dateien desselben Vertrags -> EINE neue Frist mit allen Dokumenten", () => {
    const r = pruefeNachtarbeit(eingabe([frist(DATEIEN[0]), frist(DATEIEN[1], "SCALA BASEL"), frist(DATEIEN[2]), frist(DATEIEN[3], "Verein Scala Basel")]), daten());
    expect(r.fristen).toHaveLength(1);
    expect(r.fristen[0]).toMatchObject({ pfad: DATEIEN[0], datum: "2027-06-30", sachverhalt: "kuendigung:scala basel", weitere_pfade: DATEIEN.slice(1) });
    expect(r.zusammengefuehrt).toBe(3);
    expect(r.abgewiesen).toEqual([]);
  });

  it("offener Vorschlag in der DB -> Dokument wird ergaenzt, keine neue Zeile", () => {
    const sachverhalte = new Map([[sachSchluessel("kuendigung:scala basel", "2027-06-30"), { id: "f1", status: "vorschlag" as const }]]);
    const r = pruefeNachtarbeit(eingabe([frist(DATEIEN[2])]), daten({ sachverhalte }));
    expect(r.fristen).toHaveLength(0);
    expect(r.fristErgaenzt).toEqual([{ id: "f1", pfad: DATEIEN[2] }]);
  });

  it("schon entschieden (bestaetigt/verworfen/erledigt) -> frist_bekannt, nie wiederbelebt", () => {
    for (const status of ["aktiv", "verworfen", "erledigt"] as const) {
      const sachverhalte = new Map([[sachSchluessel("kuendigung:scala basel", "2027-06-30"), { id: "f1", status }]]);
      const r = pruefeNachtarbeit(eingabe([frist(DATEIEN[3])]), daten({ sachverhalte }));
      expect(r.fristen).toHaveLength(0);
      expect(r.fristErgaenzt).toHaveLength(0);
      expect(r.abgewiesen).toEqual([{ liste: "fristen", index: 0, grund: "frist_bekannt" }]);
    }
  });

  it("weitere Dokumente einer Frist gelten als bekannt (Pfad-Schluessel)", () => {
    const r = pruefeNachtarbeit(eingabe([frist(DATEIEN[1])]), daten({ fristen: new Set([fristSchluesselPfad(DATEIEN[1], "2027-06-30")]) }));
    expect(r.abgewiesen).toEqual([{ liste: "fristen", index: 0, grund: "frist_bekannt" }]);
  });

  it("andere Art oder anderes Datum bleibt eigene Frist", () => {
    const r = pruefeNachtarbeit(eingabe([frist(DATEIEN[0]), frist(DATEIEN[1], "Verein SCALA BASEL", "vertragsende")]), daten());
    expect(r.fristen).toHaveLength(2);
    expect(r.zusammengefuehrt).toBe(0);
  });

  it("ohne Partei (Dateiname in der Bezeichnung) und in Personalakten: nie zusammengefuehrt", () => {
    const r = pruefeNachtarbeit(eingabe([frist(DATEIEN[0], null), frist(DATEIEN[1], null)]), daten());
    expect(r.fristen).toHaveLength(2);
    expect(r.fristen.every((f) => f.sachverhalt === null)).toBe(true);
    const p = pruefeNachtarbeit(eingabe([frist("06_PERSONAL/1001/Vertrag.pdf", "Leo")]), daten());
    expect(p.fristen[0]).toMatchObject({ sachverhalt: null, bezeichnung: "Kündigung · Vertrag.pdf" });
  });

  it("sachverhalteDerEingabe: nur gueltige, ohne Personalakten", () => {
    expect(sachverhalteDerEingabe(eingabe([frist(DATEIEN[0]), frist(DATEIEN[1], "SCALA BASEL"), frist("06_PERSONAL/1001/Vertrag.pdf", "X"), { pfad: 3 }]), [])).toEqual(["kuendigung:scala basel"]);
  });
});
