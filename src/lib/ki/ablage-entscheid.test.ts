import { describe, expect, it, vi } from "vitest";
import { baueEingabe, entscheideOrdner, wissenFuerAblage } from "./ablage-entscheid";
import type { AblageAnalyseErgebnis, AblageAnalyseKontext, AblageEinordnung } from "./typen";
import { WISSEN_CLAUDE_BUDGET, type WissenEintrag } from "./wissen";

// Firmenwissen beim Ablage-Entscheid (Upload und Mail-Eingang, 16.10.2026): gleiche Auswahl wie im Rueckstau ZZ.

const VERTRAEGE = "02_LOCATIONS/Halle_Nord/01_Vertraege";
const RECHNUNGEN = "03_FINANZEN/Rechnungen/2026";
const ORDNER = ["02_LOCATIONS", "02_LOCATIONS/Halle_Nord", VERTRAEGE, "03_FINANZEN", "03_FINANZEN/Rechnungen", RECHNUNGEN];

const w = (id: string, kategorie: WissenEintrag["kategorie"], begriff: string, erklaerung: string, extra: Partial<WissenEintrag> = {}): WissenEintrag => ({
  id, kategorie, begriff, erklaerung, bezug_art: null, bezug_id: null, bezug_name: null, aktiv: true, ...extra,
});

const WISSEN: WissenEintrag[] = [
  w("1", "abkuerzung", "HN", "Halle Nord, Location in Basel"),
  w("2", "zuordnung", "Muster Licht AG", "ist Lieferant (Licht), kein Kunde"),
  w("3", "benennung", "Mietvertrag", "immer mit Jahr vorne"),
  w("4", "ordner", "Locations", `Mietverträge liegen unter ${VERTRAEGE}`),
  w("5", "sonstiges", "Probelauf", "kommt hier nicht vor"),
  w("6", "ansprechpartner", "Facility", "Ansprechpartner der Location", { bezug_art: "location", bezug_id: "00000000-0000-0000-0000-000000000001", bezug_name: "Halle Nord" }),
];

const EINORDNUNG: AblageEinordnung = {
  was: "Mietvertrag für die HN mit Nebenkosten.",
  typ: "vertrag",
  betreff: "Miete HN 2026",
  partei: "Muster Licht AG",
  bezug: { art: "location", name: "Halle Nord" },
  jahr: "2026",
  personenbezogen: false,
  sprache: "de",
  seiten: 3,
};

const KONTEXT: AblageAnalyseKontext = { ordner: ORDNER, dok_typen: [{ key: "vertrag", label: "Vertrag", person: false }], mitarbeiter: [], namen_alle: [], heute: "2026-10-16" };

const LOKAL: AblageAnalyseErgebnis = {
  beschrieb: "Mietvertrag", typ: "vertrag", betreff: "Miete", person: null, partei: null, nummer: null, dok_datum: null, frist: null,
  ordner: VERTRAEGE, ordner_alternativen: [], neuer_ordner: null, zusammenfassung: "", sha256: "0".repeat(64), seiten: 3, ocr: false,
  modell: "gemma3:4b", dauer_ms: 1,
};

const ROH = { einordnung: { ...EINORDNUNG }, kandidaten: [{ pfad: VERTRAEGE, quelle: "vorbild", gewicht: 0.9 }], regel_ordner: null };
const ANTWORT = { ordner: VERTRAEGE, alternativen: [], sicherheit: "hoch", begruendung: "Mietvertrag der Location" };

describe("wissenFuerAblage", () => {
  it("wie im Rückstau ZZ: Begriff/Bezug in Einordnung, Dateiname oder Kandidaten — ohne Benennungsregeln", () => {
    const zeilen = wissenFuerAblage(WISSEN, { dateiname: "scan.pdf", einordnung: EINORDNUNG, kandidaten: [VERTRAEGE] });
    const text = zeilen.join("\n");
    expect(text).toContain("[Abkürzung/Begriff] HN: Halle Nord, Location in Basel");
    expect(text).toContain("[Zuordnung] Muster Licht AG: ist Lieferant (Licht), kein Kunde");
    expect(text).toContain("[Ansprechpartner/Rolle] Facility: Ansprechpartner der Location (Location: Halle Nord)");
    expect(text).toContain("[Ordner-Hinweis] Locations");
    expect(text).not.toContain("Benennungsregel");
    expect(text).not.toContain("Probelauf");
  });

  it("Dateiname zählt mit; ohne Treffer leer; Budget wie im Rückstau ZZ", () => {
    const ohne = { ...EINORDNUNG, was: "Brief.", betreff: "", partei: null, bezug: { art: null, name: null } };
    expect(wissenFuerAblage(WISSEN, { dateiname: "brief.pdf", einordnung: ohne, kandidaten: [] })).toEqual([]);
    expect(wissenFuerAblage(WISSEN, { dateiname: "Probelauf 3.pdf", einordnung: ohne, kandidaten: [] })).toHaveLength(1);
    const viele = Array.from({ length: 40 }, (_, i) => w(`v${i}`, "abkuerzung", `AB${i}`, "x".repeat(200)));
    const lang = { ...EINORDNUNG, was: Array.from({ length: 40 }, (_, i) => `AB${i}`).join(" ") };
    const zeilen = wissenFuerAblage(viele, { dateiname: "", einordnung: lang, kandidaten: [] });
    expect(zeilen.length).toBeGreaterThan(0);
    expect(zeilen.length).toBeLessThan(40);
    expect(zeilen.reduce((n, z) => n + z.length + 1, 0)).toBeLessThanOrEqual(WISSEN_CLAUDE_BUDGET);
  });
});

describe("baueEingabe: Abschnitt Firmenwissen", () => {
  const basis = { ordner: ORDNER, einordnung: EINORDNUNG, kandidaten: [], lokalOrdner: null, lokalAlternativen: [] };
  it("mit Zeilen zwischen Einordnung und Kandidaten, sonst «keines»", () => {
    const mit = baueEingabe({ ...basis, wissen: ["- [Abkürzung/Begriff] HN: Halle Nord"] });
    expect(mit).toContain("Firmenwissen des Teams (gilt vor deinen Annahmen):\n- [Abkürzung/Begriff] HN: Halle Nord\n\nKandidaten");
    expect(mit.indexOf("Einordnung des Dokuments")).toBeLessThan(mit.indexOf("Firmenwissen des Teams"));
    expect(baueEingabe(basis)).toContain("Firmenwissen des Teams (gilt vor deinen Annahmen):\n- keines zu diesem Dokument");
  });
});

describe("entscheideOrdner mit Firmenwissen", () => {
  it("Claude bekommt das passende Wissen; geladen genau einmal, erst beim Fragen", async () => {
    const wissen = vi.fn(async () => WISSEN);
    const frageClaude = vi.fn<(eingabe: string) => Promise<unknown>>(async () => ANTWORT);
    const e = await entscheideOrdner(LOKAL, ROH, KONTEXT, { verfuegbar: () => true, frageClaude, wissen, dateiname: "HN Mietvertrag.pdf" });
    expect(e.ordner).toBe(VERTRAEGE);
    expect(e.ordner_quelle).toBe("claude");
    expect(wissen).toHaveBeenCalledTimes(1);
    const eingabe = frageClaude.mock.calls[0][0];
    expect(eingabe).toContain("[Abkürzung/Begriff] HN: Halle Nord, Location in Basel");
    expect(eingabe).not.toContain("Benennungsregel");
    expect(eingabe).not.toContain("HN Mietvertrag.pdf"); // der Dateiname waehlt nur aus, er geht nicht an Claude
  });

  it("ohne Claude-Aufruf (Regel, Personenbezug, kein Schlüssel) wird das Wissen gar nicht geladen", async () => {
    const wissen = vi.fn(async () => WISSEN);
    const frageClaude = vi.fn(async () => ANTWORT);
    await entscheideOrdner(LOKAL, { ...ROH, regel_ordner: RECHNUNGEN }, KONTEXT, { verfuegbar: () => true, frageClaude, wissen });
    await entscheideOrdner(LOKAL, { ...ROH, einordnung: { ...EINORDNUNG, personenbezogen: true } }, KONTEXT, { verfuegbar: () => true, frageClaude, wissen });
    await entscheideOrdner(LOKAL, ROH, KONTEXT, { verfuegbar: () => false, frageClaude, wissen });
    expect(wissen).not.toHaveBeenCalled();
    expect(frageClaude).not.toHaveBeenCalled();
  });

  it("scheitert das Laden, entscheidet Claude trotzdem (ohne Wissen)", async () => {
    const frageClaude = vi.fn<(eingabe: string) => Promise<unknown>>(async () => ANTWORT);
    const e = await entscheideOrdner(LOKAL, ROH, KONTEXT, {
      verfuegbar: () => true, frageClaude, wissen: async () => { throw new Error("ki_wissen fehlt"); },
    });
    expect(e.ordner_quelle).toBe("claude");
    expect(frageClaude.mock.calls[0][0]).toContain("- keines zu diesem Dokument");
  });
});
