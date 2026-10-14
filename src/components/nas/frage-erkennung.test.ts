import { describe, expect, it } from "vitest";
import { istArchivFrage, normalisiereFrage } from "./frage-erkennung";

describe("istArchivFrage", () => {
  it("Stichworte sind nur Suche", () => {
    for (const t of [
      "",
      "   ",
      "Mietvertrag",
      "Mietvertrag Scala",
      "Mietvertrag Scala 2026",
      "Rechnung Catering Mai",
      "Wohnung Basel Miete",
      "Woche 42 Einsatzplan",
      "Werkvertrag Herzog Tech",
      "Rechnung ist bezahlt",
      "Mietvertrag?",
      "Mietvertrag Scala?",
      "wann",
      "wie viel",
      "Bis wann",
      "Hat",
    ]) {
      expect(istArchivFrage(t), t).toBe(false);
    }
  });

  it("Fragen an den Inhalt", () => {
    for (const t of [
      "Bis wann läuft der Mietvertrag",
      "wie hoch ist die Haftpflicht?",
      "Wie viele Gäste passen in die Scala",
      "Wann endet die Kündigungsfrist",
      "Was kostet das Catering pro Person",
      "Wer hat den Vertrag unterschrieben",
      "Wo liegt der Versicherungsnachweis",
      "Welche Versicherung haben wir",
      "Welcher Lieferant macht die Technik",
      "Warum wurde die Rechnung storniert",
      "Seit wann gilt der neue Tarif",
      "Gibt es eine Kündigungsfrist",
      "Haben wir eine Betriebshaftpflicht",
      "Hat Scala die Rechnung bezahlt",
      "Ist der Mietvertrag gekündigt",
      "Sind die Löhne für Mai abgerechnet",
      "Kann man den Vertrag vorzeitig kündigen",
      "Muss die Bewilligung erneuert werden",
      "Darf im Saal geraucht werden",
      "Mietvertrag Scala Basel?",
      "Mietvertrag Scala Basel ?",
      "  bis   wann läuft   der Vertrag  ",
      "WIE HOCH IST DIE MIETE",
      "worüber wurde im Vertrag verhandelt",
    ]) {
      expect(istArchivFrage(t), t).toBe(true);
    }
  });

  it("Grenzen: Länge und Zeichen", () => {
    expect(istArchivFrage("Was " + "x".repeat(600) + " ist das?")).toBe(false);
    expect(istArchivFrage("? ? ?")).toBe(false);
    expect(istArchivFrage("Wie, bitte, was")).toBe(true);
  });

  it("normalisiereFrage fasst Leerraum zusammen", () => {
    expect(normalisiereFrage("  Bis  wann\n läuft  ")).toBe("Bis wann läuft");
  });
});
