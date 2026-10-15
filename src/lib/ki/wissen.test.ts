import { describe, expect, it } from "vitest";
import {
  frageSchluessel,
  leseRueckfragen,
  leseWissenEingabe,
  waehleWissen,
  WISSEN_BENENNUNG_BUDGET,
  wissenFuerRig,
  zeileWissen,
  type WissenEintrag,
} from "./wissen";
import { leseZzBeschrieb } from "./zz-entscheid";

// Wissen der KI (Migration 344): Eingaben, Relevanzauswahl, Rueckfragen — rein, ohne DB und ohne Claude.

let n = 0;
const e = (p: Partial<WissenEintrag>): WissenEintrag => ({
  id: `w${++n}`, kategorie: "abkuerzung", begriff: "X", erklaerung: "Erklärung", bezug_art: null, bezug_id: null,
  bezug_name: null, aktiv: true, ...p,
});

const BESCHRIEB = leseZzBeschrieb({
  dokumentart: "Offerte", titel: "Offerte Lichttechnik Sommerfest", zweck: "Angebot für das Sommerfest der BSU am Rhein.",
  beteiligte: [{ name: "Muster Licht AG", rolle: "Anbieter" }], schlagworte: ["Licht", "Sommerfest"], unbekannt: ["datum"],
}, [])!;

describe("leseWissenEingabe", () => {
  it("nimmt gültige Einträge, trimmt, prüft Bezug", () => {
    const r = leseWissenEingabe({ kategorie: "abkuerzung", begriff: "  BSU ", erklaerung: " Basler Stadtunterhaltung ", aktiv: true });
    expect(r).toEqual({ ok: true, wert: { kategorie: "abkuerzung", begriff: "BSU", erklaerung: "Basler Stadtunterhaltung", bezug_art: null, bezug_id: null, aktiv: true } });
    const mit = leseWissenEingabe({ kategorie: "zuordnung", begriff: "Muster Licht", erklaerung: "Lieferant für Licht", bezug_art: "lieferant", bezug_id: "3F2504E0-4F89-11D3-9A0C-0305E82C3301" });
    expect(mit.ok && mit.wert.bezug_id).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });
  it("lehnt Unvollständiges, Zu-Langes und sensible Werte ab", () => {
    expect(leseWissenEingabe({ kategorie: "erfunden", begriff: "a", erklaerung: "b" }).ok).toBe(false);
    expect(leseWissenEingabe({ kategorie: "sonstiges", begriff: "", erklaerung: "b" }).ok).toBe(false);
    expect(leseWissenEingabe({ kategorie: "sonstiges", begriff: "a", erklaerung: "  " }).ok).toBe(false);
    expect(leseWissenEingabe({ kategorie: "sonstiges", begriff: "a".repeat(121), erklaerung: "b" }).ok).toBe(false);
    expect(leseWissenEingabe({ kategorie: "sonstiges", begriff: "a", erklaerung: "b".repeat(1001) }).ok).toBe(false);
    for (const erklaerung of ["Kontakt max@muster.ch", "Konto CH93 0076 2011 6238 5295 7", "Tel +41 61 123 45 67", "Pauschale CHF 1200", "krankgeschrieben"]) {
      expect(leseWissenEingabe({ kategorie: "ansprechpartner", begriff: "Max", erklaerung }).ok, erklaerung).toBe(false);
      // auch hinten in einer langen Erklärung und über die 300-Zeichen-Grenze der Fakten-Hinweise hinweg
      expect(leseWissenEingabe({ kategorie: "ansprechpartner", begriff: "Max", erklaerung: `${"Text ".repeat(150)}${erklaerung}` }).ok, `lang: ${erklaerung}`).toBe(false);
      expect(leseWissenEingabe({ kategorie: "ansprechpartner", begriff: "Max", erklaerung: `${"x".repeat(292)} ${erklaerung}` }).ok, `Grenze: ${erklaerung}`).toBe(false);
    }
    expect(leseWissenEingabe({ kategorie: "zuordnung", begriff: "a", erklaerung: "b", bezug_art: "kunde", bezug_id: "kein-uuid" }).ok).toBe(false);
    expect(leseWissenEingabe({ kategorie: "zuordnung", begriff: "a", erklaerung: "b", bezug_art: "erfunden", bezug_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }).ok).toBe(false);
  });
});

describe("waehleWissen — Relevanz für Claude", () => {
  const anlass = { dateiname: "Offerte_BSU.pdf", herkunft: ["Offerten 2025"], beschrieb: BESCHRIEB, kandidaten: ["03_PROJEKTE/2025_Sommerfest/Offerten"], fakten: [] };
  it("alle aktiven Benennungsregeln, dazu Treffer über Begriff, Bezug und Kandidaten-Ordner", () => {
    const alle = [
      e({ kategorie: "benennung", begriff: "Offerten", erklaerung: "JJJJ-MM-TT_Offerte_Kunde_Thema" }),
      e({ kategorie: "abkuerzung", begriff: "BSU", erklaerung: "Basler Stadtunterhaltung, Kunde" }),
      e({ kategorie: "zuordnung", begriff: "Lichtpartner", erklaerung: "Licht kommt von Muster Licht", bezug_art: "lieferant", bezug_id: "x", bezug_name: "Muster Licht AG" }),
      e({ kategorie: "ordner", begriff: "Projektofferten", erklaerung: "gehören nach 03_PROJEKTE/2025_Sommerfest/Offerten" }),
      e({ kategorie: "ansprechpartner", begriff: "Peter Beispiel", erklaerung: "Hauswart Halle Nord" }),
      e({ kategorie: "abkuerzung", begriff: "BSU", erklaerung: "inaktiv", aktiv: false }),
    ];
    const w = waehleWissen(alle, anlass);
    expect(w.map((x) => x.begriff)).toEqual(["Offerten", "BSU", "Lichtpartner", "Projektofferten"]);
    expect(zeileWissen(w[2])).toBe("- [Zuordnung] Lichtpartner: Licht kommt von Muster Licht (Lieferant: Muster Licht AG)");
  });
  it("ganze Wortfolge, Gross/klein und Umlaute egal; spezifischere zuerst; Budget in ganzen Zeilen", () => {
    const alle = [
      e({ begriff: "SU", erklaerung: "darf nicht in «BSU» treffen" }),
      e({ begriff: "rhein", erklaerung: "kurz" }),
      e({ begriff: "Sommerfest am Rhein", erklaerung: "lang" }),
    ];
    expect(waehleWissen(alle, anlass).map((x) => x.begriff)).toEqual(["rhein"]);
    const lang = { ...anlass, beschrieb: leseZzBeschrieb({ zweck: "Sommerfest am Rhein mit der BSÜ" }, [])! };
    expect(waehleWissen(alle, lang).map((x) => x.begriff)).toEqual(["Sommerfest am Rhein", "rhein"]);
    const viele = Array.from({ length: 40 }, (_, i) => e({ kategorie: "benennung", begriff: `Regel ${i}`, erklaerung: "x".repeat(80) }));
    const gewaehlt = waehleWissen(viele, anlass);
    expect(gewaehlt.length).toBeGreaterThan(0);
    expect(gewaehlt.reduce((s, x) => s + zeileWissen(x).length + 1, 0)).toBeLessThanOrEqual(WISSEN_BENENNUNG_BUDGET);
  });
  it("ohne Beschrieb (alter Stand) und ohne Treffer: nur die Benennungsregeln", () => {
    const w = waehleWissen([e({ kategorie: "benennung", begriff: "Regel", erklaerung: "x" }), e({ begriff: "Fremd", erklaerung: "y" })],
      { dateiname: "a.pdf", herkunft: [], beschrieb: null, kandidaten: [], fakten: [] });
    expect(w.map((x) => x.begriff)).toEqual(["Regel"]);
  });
  it("ans Rig nur aktive Einträge, Erklärung gekappt", () => {
    const r = wissenFuerRig([e({ begriff: "A", erklaerung: "x".repeat(900), bezug_name: "Halle" }), e({ begriff: "B", aktiv: false })]);
    expect(r).toEqual([{ kategorie: "abkuerzung", begriff: "A", erklaerung: "x".repeat(600), bezug: "Halle" }]);
  });
});

describe("Rückfragen", () => {
  it("gleicher Begriff = gleiche Frage, auch anders formuliert; ohne Begriff die Inhaltswörter", () => {
    expect(frageSchluessel("abkuerzung", "BSU", "Was bedeutet BSU?")).toBe(frageSchluessel("abkuerzung", " bsu ", "Wofür steht die Abkürzung BSU?"));
    expect(frageSchluessel("abkuerzung", "BSU", "x")).not.toBe(frageSchluessel("zuordnung", "BSU", "x"));
    expect(frageSchluessel("sonstiges", null, "Gehört die Halle zur Location?")).toBe(frageSchluessel("sonstiges", "", "Location: gehört die Halle dazu?"));
  });
  it("höchstens 2, bekannte Art, ohne sensible Werte, dedupliziert", () => {
    const r = leseRueckfragen([
      { art: "abkuerzung", begriff: "BSU", frage: "Was bedeutet die Abkürzung BSU?" },
      { art: "abkuerzung", begriff: "bsu", frage: "Wofür steht BSU?" },
      { art: "zuordnung", begriff: "Muster Licht AG", frage: "Ist Muster Licht AG Kunde oder Lieferant?" },
      { art: "person", begriff: "Max", frage: "Wer ist Max?" },
    ]);
    expect(r.map((x) => [x.art, x.begriff])).toEqual([["abkuerzung", "BSU"], ["zuordnung", "Muster Licht AG"]]);
    for (const frage of ["Gehört die Rechnung über CHF 1'200 zur Location?", "Ist Muster-Strasse 6 die Adresse der Halle?",
      "Gehört Konto CH93 0076 2011 6238 5295 7 zur Firma?", "Ist die Nummer 8812345 eine Police?", "kurz?"]) {
      expect(leseRueckfragen([{ art: "sonstiges", begriff: "", frage }]), frage).toEqual([]);
    }
    expect(leseRueckfragen([{ art: "erfunden", begriff: "x", frage: "Was ist das hier genau?" }])).toEqual([]);
    expect(leseRueckfragen("kaputt")).toEqual([]);
  });
});
