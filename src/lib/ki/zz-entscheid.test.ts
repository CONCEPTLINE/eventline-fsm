import { describe, expect, it } from "vitest";
import {
  baueZzEingabe,
  DOKUMENT_MARKER,
  dokartAus,
  filtereFakt,
  herkunftAusPfad,
  leseZzBeschrieb,
  validiereZzEntscheid,
  waehleBeispiele,
  type Lernbeispiel,
} from "./zz-entscheid";

const ORDNER = [
  "02_LOCATIONS",
  "02_LOCATIONS/002506_SCALA_BASEL",
  "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege",
  "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/01_Entwuerfe",
  "06_PERSONAL",
  "06_PERSONAL/01_Personalakten_Festangestellt",
  "06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm",
  "06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm/01_Vertraege_Anstellung",
  "06_PERSONAL/02_Personalakten_Ehmalige",
  "ZZ_Dokumente_zum_Einsortieren/_EVENTLINE",
];
const AKTIV = new Set(ORDNER);
const VOLKER = "ZZ_Dokumente_zum_Einsortieren/_EVENTLINE/Vertraege_und_Recht/Verein EVENTLINE/2025-Personal/Volker Hassemer/Beilage zum Arbeitsvertrag – Techniker Volker Hassemer .pdf";

const roh = {
  typ: "vertrag",
  typ_label: "Vertrag",
  dokumentart: "Beilage zum Arbeitsvertrag",
  unterart: "Stellenbeschrieb Techniker",
  titel: "Beilage Arbeitsvertrag Techniker",
  zweck: "Beschreibt die Aufgaben als Techniker; Lohn CHF 28.– pro Stunde",
  bezug: "Beilage zum Arbeitsvertrag mit dem Verein EVENTLINE",
  status: "unterschrieben",
  datum: "2025-03-01",
  beteiligte: [
    { name: "Verein EVENTLINE", rolle: "Arbeitgeber" },
    { name: "Volker Hassemer", rolle: "Arbeitnehmer, Techniker" },
    { name: "Volker Hassemer", rolle: "doppelt" },
  ],
  schlagworte: ["Techniker", "AHV 756.1234.5678.97", "Anstellung", "„Der Arbeitnehmer verpflichtet sich zu allem“"],
  seiten: 2,
  teile: 1,
  gelesen: "ganz gelesen",
  dateityp: "pdf",
  ocr: false,
  personenbezogen: true,
};

describe("leseZzBeschrieb — Filter ohne sensible Werte", () => {
  it("lässt Felder mit Betrag/AHV/Zitat ganz weg, behält Personen und Rollen", () => {
    const b = leseZzBeschrieb(roh, [])!;
    expect(b.dokumentart).toBe("Beilage zum Arbeitsvertrag");
    expect(b.zweck).toBeNull();
    expect(b.schlagworte).toEqual(["Techniker", "Anstellung"]);
    expect(b.beteiligte.map((x) => x.name)).toEqual(["Verein EVENTLINE", "Volker Hassemer"]);
    expect(b.status).toBe("unterschrieben");
    expect(b.datum).toBe("2025-03-01");
    expect(JSON.stringify(b)).not.toMatch(/756\.|CHF|28\.–|verpflichtet/);
  });
  it("verwirft Telefon, IBAN, Adresse, E-Mail, Gesundheit", () => {
    for (const s of ["Tel. 061 123 45 67", "IBAN CH93 0076 2011 6238 5295 7", "Hauptstrasse 12", "info@x.ch", "Kündigung wegen Krankheit"]) {
      expect(leseZzBeschrieb({ zweck: s }, [])!.zweck).toBeNull();
    }
    expect(leseZzBeschrieb("text", [])).toBeNull();
    expect(leseZzBeschrieb({ status: "geheim", datum: "gestern", sprache: "Deutsch" }, [])).toMatchObject({ status: null, datum: null, sprache: null });
  });
});

describe("Fakten, Herkunft, Dokumentart", () => {
  it("erlaubt Pfade mit Nummern, verbietet Beträge/Konten", () => {
    expect(filtereFakt("Location erkannt: 02_LOCATIONS/002506_SCALA_BASEL; INT-26-100-BA")).toContain("002506");
    expect(filtereFakt("Lohn CHF 5'000")).toBeNull();
    expect(filtereFakt("Konto CH93 0076 2011 6238 5295 7")).toBeNull();
    expect(filtereFakt(42)).toBeNull();
  });
  it("Herkunft = Segmente unter der ZZ-Freigabe", () => {
    expect(herkunftAusPfad(VOLKER)).toEqual(["_EVENTLINE", "Vertraege_und_Recht", "Verein EVENTLINE", "2025-Personal", "Volker Hassemer"]);
    expect(herkunftAusPfad("02_LOCATIONS/a.pdf")).toEqual([]);
    expect(dokartAus(leseZzBeschrieb(roh, [])!)).toBe("beilage zum arbeitsvertrag");
  });
});

describe("baueZzEingabe — Prompt", () => {
  const b = leseZzBeschrieb(roh, [])!;
  const eingabe = baueZzEingabe({
    ordner: ORDNER,
    beschrieb: b,
    dateiname: "Beilage zum Arbeitsvertrag – Techniker Volker Hassemer .pdf",
    herkunft: herkunftAusPfad(VOLKER),
    fakten: ["Person erkannt im Dateinamen: Volker Hassemer", "Keine Personalakte für Volker Hassemer gefunden"],
    kandidaten: ["06_PERSONAL/02_Personalakten_Ehmalige"],
    namenJeOrdner: new Map([["06_PERSONAL/01_Personalakten_Festangestellt/2002_Tim_Böhm/01_Vertraege_Anstellung", ["2026-01-05_Arbeitsvertrag_Tim-Boehm.pdf"]]]),
  });
  it("Ordnerbaum vorne (gecacht), ohne ZZ; Dokumentteil mit Beschrieb, Herkunft, Fakten", () => {
    const [baum, dok] = eingabe.split(DOKUMENT_MARKER);
    expect(baum).toContain("06_PERSONAL/02_Personalakten_Ehmalige");
    expect(baum).not.toContain("ZZ_Dokumente");
    expect(dok).toContain("2025-Personal / Volker Hassemer");
    expect(dok).toContain("Volker Hassemer (Arbeitnehmer, Techniker)");
    expect(dok).toContain("Keine Personalakte für Volker Hassemer");
    expect(dok).toContain("2026-01-05_Arbeitsvertrag_Tim-Boehm.pdf");
    expect(dok).toContain("Fruehere Entscheide des Teams");
  });
  it("trägt nie sensible Werte", () => {
    expect(eingabe).not.toMatch(/756\.|CHF|28\.–/);
  });
});

describe("validiereZzEntscheid", () => {
  const original = "Beilage zum Arbeitsvertrag – Techniker Volker Hassemer .pdf";
  it("neue Akte unter bestehendem Sammelordner (Volker) → ziel_neu, höchstens mittel", () => {
    const e = validiereZzEntscheid(
      {
        ziel_ordner: "06_PERSONAL/02_Personalakten_Ehmalige/2010_Volker_Hassemer",
        ziel_neu: true,
        name_vorschlag: "2025-03-01_Arbeitsvertrag-Beilage_Volker-Hassemer.pdf",
        begruendung: "Personendokument von Volker Hassemer; eigene Akte fehlt.",
        sicherheit: "hoch",
        alternativen: ["06_PERSONAL/02_Personalakten_Ehmalige", "erfunden/x", "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/01_Entwuerfe"],
      },
      { aktiv: AKTIV, originalName: original },
    )!;
    expect(e).toMatchObject({ ziel_neu: true, sicherheit: "mittel", name_vorschlag: "2025-03-01_Arbeitsvertrag-Beilage_Volker-Hassemer.pdf" });
    expect(e.alternativen).toEqual(["06_PERSONAL/02_Personalakten_Ehmalige", "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege/01_Entwuerfe"]);
  });
  it("lehnt Erfundenes, ZZ, zwei neue Ebenen und falsche Endung ab", () => {
    const basis = { ziel_neu: false, name_vorschlag: "", begruendung: "", sicherheit: "mittel", alternativen: [] };
    expect(validiereZzEntscheid({ ...basis, ziel_ordner: "06_PERSONAL/gibtsnicht" }, { aktiv: AKTIV, originalName: original })).toBeNull();
    expect(validiereZzEntscheid({ ...basis, ziel_ordner: "ZZ_Dokumente_zum_Einsortieren/_EVENTLINE" }, { aktiv: AKTIV, originalName: original })).toBeNull();
    expect(validiereZzEntscheid({ ...basis, ziel_neu: true, ziel_ordner: "06_PERSONAL/02_Personalakten_Ehmalige/X/Y" }, { aktiv: AKTIV, originalName: original })).toBeNull();
    expect(validiereZzEntscheid({ ...basis, ziel_neu: true, ziel_ordner: "NEU_OBEN" }, { aktiv: AKTIV, originalName: original })).toBeNull();
    const e = validiereZzEntscheid({ ...basis, ziel_ordner: "06_PERSONAL/02_Personalakten_Ehmalige", name_vorschlag: "x.docx", begruendung: "Lohn CHF 28" }, { aktiv: AKTIV, originalName: original })!;
    expect(e.name_vorschlag).toBeNull();
    expect(e.begruendung).toBe("");
    // «neu» gemeldet, aber existiert schon → bestehend.
    expect(validiereZzEntscheid({ ...basis, ziel_neu: true, ziel_ordner: "06_PERSONAL/02_Personalakten_Ehmalige" }, { aktiv: AKTIV, originalName: original })!.ziel_neu).toBe(false);
  });
});

describe("waehleBeispiele — Lernen aus Korrekturen", () => {
  const b = leseZzBeschrieb(roh, [])!;
  const zeile = (over: Partial<Lernbeispiel>): Lernbeispiel => ({
    aktion: "korrigiert",
    beschrieb: { dokumentart: "Offerte", titel: "Bühnentechnik" },
    dokart: "offerte",
    original_name: "a.pdf",
    vorgeschlagen_ordner: "x",
    final_ordner: "y",
    vorgeschlagen_name: null,
    final_name: null,
    ordner_geaendert: true,
    name_geaendert: false,
    ...over,
  });
  it("nimmt gleiche Dokumentart/Person, höchstens 3 Bestätigungen, neueste zuerst", () => {
    const zeilen: Lernbeispiel[] = [
      zeile({ original_name: "fremd.pdf" }),
      zeile({ original_name: "beilage1.pdf", dokart: "beilage zum arbeitsvertrag", beschrieb: { dokumentart: "Beilage zum Arbeitsvertrag" } }),
      ...[1, 2, 3, 4, 5].map((i) =>
        zeile({ original_name: `ok${i}.pdf`, aktion: "angenommen", ordner_geaendert: false, dokart: "beilage zum arbeitsvertrag", beschrieb: { dokumentart: "Beilage zum Arbeitsvertrag" } }),
      ),
      zeile({ original_name: "person.pdf", dokart: "zeugnis", beschrieb: { dokumentart: "Zeugnis", beteiligte: [{ name: "Volker Hassemer", rolle: "" }] } }),
    ];
    const w = waehleBeispiele(b, zeilen, 10).map((x) => x.original_name);
    expect(w).not.toContain("fremd.pdf");
    expect(w).toContain("beilage1.pdf");
    expect(w).toContain("person.pdf");
    expect(w.filter((n) => n?.startsWith("ok"))).toEqual(["ok1.pdf", "ok2.pdf", "ok3.pdf"]);
    expect(w.indexOf("beilage1.pdf")).toBeLessThan(w.indexOf("person.pdf"));
    expect(waehleBeispiele(b, zeilen, 2)).toHaveLength(2);
  });
  it("Beispiele im Prompt zeigen Vorschlag → Korrektur, ohne sensible Werte", () => {
    const beispiele = [zeile({ beschrieb: { dokumentart: "Offerte", zweck: "Preis CHF 900" }, final_name: "2026-01-01_Offerte_Herzog-Tech.pdf", name_geaendert: true })];
    const eingabe = baueZzEingabe({ ordner: ORDNER, beschrieb: b, dateiname: "a.pdf", herkunft: [], fakten: [], kandidaten: [], namenJeOrdner: new Map(), beispiele });
    expect(eingabe).toContain("KORRIGIERT (Ordner + Name) zu y · «2026-01-01_Offerte_Herzog-Tech.pdf»");
    expect(eingabe).not.toContain("CHF 900");
  });
});
