import { describe, expect, it } from "vitest";
import { dateiEndung, pruefeDateiname, pruefeNeuenDateinamen } from "./dateiname";

// Namensvorschlag/neuer Dateiname (Migration 329): gueltig nur mit gleicher
// Endung und ohne Inhaltsangaben — sonst verworfen (null), nie repariert.

const ORIGINAL = "20260828191911_001.pdf";

describe("pruefeNeuenDateinamen: gueltig", () => {
  it.each([
    "2025-03-01_Arbeitsvertrag-Beilage_Volker-Hassemer.pdf",
    "2026-08-28_Scan_Rechnung_Herzog-Tech.pdf",
    "20260828_Scan_Offerte_SCALA-BASEL.pdf",
    "260828_Protokoll_Teamsitzung.pdf",
    "2025_Arbeitsvertrag_Muster.PDF",
    "Mietvertrag Lager Münchenstein.pdf",
    "Konzept_Spring_2025.pdf",
    "Lieferung_via_Post_2_Pakete.pdf",
    "Plan_Halle_3_Buehne_2.pdf",
  ])("%s", (name) => {
    expect(pruefeNeuenDateinamen(name, ORIGINAL)).toBe(name.normalize("NFC"));
  });

  it("trimmt und normalisiert auf NFC", () => {
    const nfd = "  Lieferschein_Bäckerei.pdf ";
    expect(pruefeNeuenDateinamen(nfd, ORIGINAL)).toBe("Lieferschein_Bäckerei.pdf");
  });

  it("Endung case-insensitiv gleich", () => {
    expect(pruefeNeuenDateinamen("Scan_Quittung.pdf", "SCAN.PDF")).toBe("Scan_Quittung.pdf");
    expect(dateiEndung("a.b.DOCX")).toBe("docx");
    expect(dateiEndung(".gitignore")).toBe("");
  });
});

describe("pruefeNeuenDateinamen: verworfen", () => {
  it.each([
    ["Betrag", "Lohn_28_CHF.pdf"],
    ["Betrag vorne", "Rechnung_CHF-1200.pdf"],
    ["Betrag Fr.", "Spesen_Fr._45.pdf"],
    ["Betrag Euro", "Offerte_300€.pdf"],
    ["Betrag .–", "Miete_1200.–.pdf"],
    ["Prozent", "Rabatt_15%.pdf"],
    ["IBAN", "Konto_CH9300762011623852957.pdf"],
    ["IBAN mit Abstaenden", "Konto CH93 0076 2011 6238 5295 7.pdf"],
    ["AHV", "Ausweis_756.1234.5678.97.pdf"],
    ["Telefon international", "Kontakt_+41_61_123_45_67.pdf"],
    ["Telefon CH", "Rueckruf_061 123 45 67.pdf"],
    ["E-Mail", "Anfrage_max.muster@example.ch.pdf"],
    ["lange Zahl", "Police_8812345.pdf"],
    ["Scanner-Zeitstempel", "20260828191911_Scan.pdf"],
    ["Nr.", "Kunden-Nr._12.pdf"],
    ["#", "Auftrag_#77.pdf"],
    ["Kundennummer", "Kundennummer_88.pdf"],
    ["Strasse + Hausnummer", "Wohnung_Hauptstrasse_12.pdf"],
    ["str. + Hausnummer", "Zuegelung_Bahnhofstr._7a.pdf"],
    ["Strasse mit Bindestrich", "Mietvertrag_Muster-Strasse_6.pdf"],
    ["Weg mit Bindestrich", "Plan_Hinterer-Weg_12.pdf"],
    ["Gasse", "Uebergabe_Muster-Gasse_4.pdf"],
    ["Platz", "Halle_Barfüsser-Platz_1.pdf"],
    ["Str ohne Punkt", "Lieferung_Bahnhofstr_12.pdf"],
    ["Vorstadt", "Vertrag_St. Alban-Vorstadt 6.pdf"],
    ["Graben", "Petersgraben_50.pdf"],
    ["Strasse Nr.", "Musterstrasse_Nr._7.pdf"],
    ["Rue", "Bail_Rue du Rhône 6.pdf"],
    ["PLZ + Ort", "Mietvertrag_4051_Basel.pdf"],
    ["Gesundheitswort", "Arztzeugnis_Mitarbeiter.pdf"],
    ["krank", "Krankmeldung_Oktober.pdf"],
    ["Kuendigungsgrund", "Kündigung_fristlos_wegen_Diebstahl.pdf"],
    ["falsche Endung", "2026-08-28_Scan.docx"],
    ["Endung entfernt", "2026-08-28_Scan"],
    ["Pfadtrenner /", "Ordner/Datei.pdf"],
    ["Pfadtrenner \\", "Ordner\\Datei.pdf"],
    ["Doppelpunkt", "Scan: Rechnung.pdf"],
    ["Steuerzeichen", "Scan\u0007.pdf"],
    ["Punkt vorne", ".versteckt.pdf"],
    ["unveraendert", ORIGINAL],
    ["leer", "   "],
    ["kein String", 42],
  ])("%s", (_fall, name) => {
    expect(pruefeNeuenDateinamen(name, ORIGINAL)).toBeNull();
  });

  it("zu lang", () => {
    expect(pruefeNeuenDateinamen(`${"a".repeat(157)}.pdf`, ORIGINAL)).toBeNull();
    expect(pruefeNeuenDateinamen(`${"a".repeat(156)}.pdf`, ORIGINAL)).toBe(`${"a".repeat(156)}.pdf`);
  });

  it("Grund ist lesbar (Oberflaeche)", () => {
    expect(pruefeDateiname("Scan.docx", ORIGINAL)).toEqual({ ok: false, grund: "Endung muss .pdf bleiben" });
    expect(pruefeDateiname("Lohn_28_CHF.pdf", ORIGINAL)).toEqual({ ok: false, grund: "enthält Inhaltsangabe: Betrag" });
  });
});
