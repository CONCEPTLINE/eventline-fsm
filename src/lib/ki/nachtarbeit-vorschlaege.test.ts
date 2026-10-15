import { describe, expect, it, vi } from "vitest";

// zz-entscheid (Filter des Beschriebs) hat eigene Tests — hier gemockt.
vi.mock("./zz-entscheid", () => ({
  leseZzBeschrieb: (roh: unknown) => (roh && typeof roh === "object" && !("kaputt" in roh) ? roh : null),
  filtereFakt: (f: unknown) => (typeof f === "string" && !f.includes("CHF") ? f : null),
}));

import { pruefeNachtarbeit, sperrSchluessel, vorschlagSchluessel, type NachtarbeitDaten, type NachtarbeitEingabe } from "./nachtarbeit";

// Vorschlags-Teil der Nachtarbeit (Migration 329): Rezept, Namensvorschlag
// und Ersetzen offener Vorschlaege mit aelterem Rezept.

const PFAD = "ZZ_Dokumente/20260828191911_001.pdf";
const ZIEL = "01_FIRMA/03_Rechnungen";

function daten(p: Partial<NachtarbeitDaten> = {}): NachtarbeitDaten {
  return {
    heute: "2026-10-15",
    ordnerAktiv: new Map([[ZIEL, ZIEL], ["01_FIRMA/04_Offerten", "01_FIRMA/04_Offerten"]]),
    namen: [],
    index: new Map([[PFAD, { pfad: PFAD, ordner_pfad: "ZZ_Dokumente", name: "20260828191911_001.pdf" }]]),
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

const vorschlag = (x: Record<string, unknown> = {}) => ({
  art: "zz",
  pfad: PFAD,
  ordner_ist: "ZZ_Dokumente",
  ziel_ordner: ZIEL,
  sicherheit: "hoch",
  quelle: "regel",
  begruendung: "Rechnung → Firmenrechnungen",
  ...x,
});
const eingabe = (vorschlaege: unknown[]): NachtarbeitEingabe => ({ lauf_id: "l1", modell: null, vorschlaege, fristen: [] });
const K = vorschlagSchluessel("zz", PFAD);

describe("Nachtarbeit: Rezept und Namensvorschlag", () => {
  it("uebernimmt rezept und gueltigen name_vorschlag", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag({ rezept: "zz/v3", name_vorschlag: "2026-08-28_Scan_Rechnung_Herzog-Tech.pdf" })]), daten());
    expect(r.vorschlaege).toHaveLength(1);
    expect(r.vorschlaege[0]).toMatchObject({ rezept: "zz/v3", name_vorschlag: "2026-08-28_Scan_Rechnung_Herzog-Tech.pdf" });
  });

  it("ungueltiger Name (Betrag, falsche Endung) -> still null, Vorschlag bleibt", () => {
    for (const name of ["Lohn_28_CHF.pdf", "2026-08-28_Scan.docx", "a/b.pdf"]) {
      const r = pruefeNachtarbeit(eingabe([vorschlag({ name_vorschlag: name })]), daten());
      expect(r.vorschlaege).toHaveLength(1);
      expect(r.vorschlaege[0].name_vorschlag).toBeNull();
      expect(r.abgewiesen).toEqual([]);
    }
  });

  it("ohne neue Felder (aelterer Rig-Build) wie bisher", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag()]), daten());
    expect(r.vorschlaege[0]).toMatchObject({ rezept: null, name_vorschlag: null });
    expect(r.ersetzen).toEqual([]);
  });

  it("zu langes oder leeres Rezept -> null", () => {
    expect(pruefeNachtarbeit(eingabe([vorschlag({ rezept: "x".repeat(21) })]), daten()).vorschlaege[0].rezept).toBeNull();
    expect(pruefeNachtarbeit(eingabe([vorschlag({ rezept: "  " })]), daten()).vorschlaege[0].rezept).toBeNull();
  });
});

describe("Nachtarbeit: offene Vorschlaege ersetzen", () => {
  it("offen mit aelterem Rezept -> ersetzen", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag({ rezept: "zz/v3" })]), daten({ offen: new Map([[K, { id: "alt1", rezept: "zz/v2" }]]) }));
    expect(r.vorschlaege).toEqual([]);
    expect(r.ersetzen).toHaveLength(1);
    expect(r.ersetzen[0]).toMatchObject({ altId: "alt1", zeile: { pfad: PFAD, rezept: "zz/v3" } });
    expect(r.doppelt).toBe(0);
  });

  it("offen ohne Rezept (vor Migration 329) -> ersetzen", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag({ rezept: "zz/v3" })]), daten({ offen: new Map([[K, { id: "alt1", rezept: null }]]) }));
    expect(r.ersetzen.map((x) => x.altId)).toEqual(["alt1"]);
  });

  it("gleiches Rezept -> doppelt", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag({ rezept: "zz/v3" })]), daten({ offen: new Map([[K, { id: "alt1", rezept: "zz/v3" }]]) }));
    expect(r.ersetzen).toEqual([]);
    expect(r.vorschlaege).toEqual([]);
    expect(r.doppelt).toBe(1);
  });

  it("neuer Eintrag ohne Rezept ersetzt nie", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag()]), daten({ offen: new Map([[K, { id: "alt1", rezept: "zz/v2" }]]) }));
    expect(r.ersetzen).toEqual([]);
    expect(r.doppelt).toBe(1);
  });

  it("angenommen/korrigiert (Verschiebung steht aus) -> nie ersetzen, doppelt", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag({ rezept: "zz/v3" })]), daten({ ausstehend: new Set([K]) }));
    expect(r.ersetzen).toEqual([]);
    expect(r.vorschlaege).toEqual([]);
    expect(r.doppelt).toBe(1);
  });

  it("Abgelehnt-Sperre gilt auch beim Ersetzen", () => {
    const r = pruefeNachtarbeit(
      eingabe([vorschlag({ rezept: "zz/v3" })]),
      daten({ offen: new Map([[K, { id: "alt1", rezept: "zz/v2" }]]), abgelehnt: new Set([sperrSchluessel(PFAD, ZIEL)]) }),
    );
    expect(r.ersetzen).toEqual([]);
    expect(r.abgewiesen).toEqual([{ liste: "vorschlaege", index: 0, grund: "abgelehnt_bekannt" }]);
  });

  it("zweimal dieselbe Datei in einer Lieferung -> einmal ersetzt, einmal doppelt", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag({ rezept: "zz/v3" }), vorschlag({ rezept: "zz/v3" })]), daten({ offen: new Map([[K, { id: "alt1", rezept: "zz/v2" }]]) }));
    expect(r.ersetzen).toHaveLength(1);
    expect(r.doppelt).toBe(1);
  });
});

describe("Nachtarbeit: zz mit Beschrieb (zz/v3) -> Warteschlange", () => {
  const mitBeschrieb = (x: Record<string, unknown> = {}) => ({
    art: "zz",
    pfad: PFAD,
    ordner_ist: "ZZ_Dokumente",
    rezept: "zz/v3",
    beschrieb: { dokart: "rechnung" },
    fakten: ["Absender Herzog Tech", "Betrag 200 CHF", 7],
    kandidaten: [ZIEL, "ZZ_Dokumente", "09_GIBTSNICHT", ZIEL],
    ...x,
  });

  it("legt einen Beschrieb an — ohne Ziel, Sicherheit, Quelle", () => {
    const r = pruefeNachtarbeit(eingabe([mitBeschrieb()]), daten());
    expect(r.vorschlaege).toEqual([]);
    expect(r.abgewiesen).toEqual([]);
    expect(r.beschriebe).toEqual([
      { pfad: PFAD, sha256: null, ordner_ist: "ZZ_Dokumente", rezept: "zz/v3", beschrieb: { dokart: "rechnung" }, fakten: ["Absender Herzog Tech"], kandidaten: [ZIEL], lauf_id: "l1", modell: null },
    ]);
  });

  it("ohne Rezept oder mit ungueltigem Beschrieb -> ungueltig", () => {
    expect(pruefeNachtarbeit(eingabe([mitBeschrieb({ rezept: undefined })]), daten()).abgewiesen).toEqual([{ liste: "vorschlaege", index: 0, grund: "ungueltig" }]);
    expect(pruefeNachtarbeit(eingabe([mitBeschrieb({ beschrieb: { kaputt: 1 } })]), daten()).abgewiesen).toEqual([{ liste: "vorschlaege", index: 0, grund: "ungueltig" }]);
  });

  it("Datei nicht mehr dort -> pfad_bewegt", () => {
    expect(pruefeNachtarbeit(eingabe([mitBeschrieb({ ordner_ist: "01_FIRMA" })]), daten()).abgewiesen[0].grund).toBe("pfad_bewegt");
  });

  it("offen mit gleichem Rezept oder ausstehend -> doppelt; offen mit aelterem -> Beschrieb", () => {
    expect(pruefeNachtarbeit(eingabe([mitBeschrieb()]), daten({ offen: new Map([[K, { id: "a", rezept: "zz/v3" }]]) })).doppelt).toBe(1);
    expect(pruefeNachtarbeit(eingabe([mitBeschrieb()]), daten({ ausstehend: new Set([K]) })).doppelt).toBe(1);
    expect(pruefeNachtarbeit(eingabe([mitBeschrieb()]), daten({ offen: new Map([[K, { id: "a", rezept: "zz/v2" }]]) })).beschriebe).toHaveLength(1);
  });

  it("mit ziel_ordner (alter Rig) -> wie bisher ein Vorschlag", () => {
    const r = pruefeNachtarbeit(eingabe([vorschlag({ rezept: "zz/v2", beschrieb: { dokart: "x" } })]), daten());
    expect(r.vorschlaege).toHaveLength(1);
    expect(r.beschriebe).toEqual([]);
  });

  it("hoechstens 12 Fakten und 8 Kandidaten", () => {
    const viele = Array.from({ length: 20 }, (_, i) => `Fakt ${i}`);
    const r = pruefeNachtarbeit(eingabe([mitBeschrieb({ fakten: viele })]), daten());
    expect(r.beschriebe[0].fakten).toHaveLength(12);
  });
});
