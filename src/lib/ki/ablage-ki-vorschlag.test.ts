// KI-Vorschlag einer Ablage-Karte (Migration 339): Momentaufnahme im Browser, Pruefung auf dem Server,
// Name nach demselben Schema wie der finale (Trefferquote im Technik-Dashboard).
import { describe, expect, it } from "vitest";
import { baueAblageName } from "@/lib/ablage-doktypen";
import { kiVorschlagKarte, kiVorschlagSpalten, leseKiVorschlag, leseSeiten } from "./ablage-ki-vorschlag";

const HEUTE = "2026-10-15";

describe("kiVorschlagKarte", () => {
  it("nimmt den Vorschlag der KI, nicht den still uebernommenen Ordner; neuer Ordner zaehlt als Vorschlag", () => {
    const k = kiVorschlagKarte("claude", {
      ordner: "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege", typ: "vertrag", betreff: "  Mietvertrag Saal  ",
      person: "Anna Muster", partei: "SCALA BASEL", nummer: "", dok_datum: "2026-09-30",
    });
    expect(k).toEqual({
      quelle: "claude", ordner: "02_LOCATIONS/002506_SCALA_BASEL/02_Verwaltungsvertraege", typ: "vertrag", betreff: "Mietvertrag Saal",
      person: "Anna Muster", partei: "SCALA BASEL", nummer: "", dok_datum: "2026-09-30",
    });
    expect(kiVorschlagKarte("lokal", { ordner: "", neuer_ordner: "03_PROJEKTE_EVENTS/2026/INT-26-099_Neu" }).ordner).toBe("03_PROJEKTE_EVENTS/2026/INT-26-099_Neu");
    expect(kiVorschlagKarte("lokal", { ordner: null }).ordner).toBeNull();
  });

  it("Unsinn wird leer: unbekannter Typ -> sonstiges, Pfad mit «..» oder absolut -> kein Ordner, Datum nur ISO", () => {
    const k = kiVorschlagKarte("beschrieb", { ordner: "../etc", typ: "erfunden", betreff: "x".repeat(300), dok_datum: "30.09.2026" });
    expect(k.typ).toBe("sonstiges");
    expect(k.ordner).toBeNull();
    expect(k.betreff).toHaveLength(120);
    expect(k.dok_datum).toBe("");
    expect(kiVorschlagKarte("lokal", { ordner: "/02_LOCATIONS" }).ordner).toBeNull();
  });
});

describe("leseKiVorschlag (Upload-Formular)", () => {
  it("nur gueltiges JSON mit bekannter Quelle; sonst ohne Vorschlag ablegen", () => {
    const roh = JSON.stringify({ quelle: "regel", ordner: "03_PROJEKTE_EVENTS/2026/INT-26-014_Firma", typ: "offerte", betreff: "Sommerfest", partei: "Firma AG" });
    expect(leseKiVorschlag(roh)?.quelle).toBe("regel");
    expect(leseKiVorschlag(JSON.stringify({ quelle: "geraten", ordner: "x" }))).toBeNull();
    expect(leseKiVorschlag("{kaputt")).toBeNull();
    expect(leseKiVorschlag(null)).toBeNull();
    expect(leseKiVorschlag("[1,2]")).toBeNull();
    expect(leseKiVorschlag("x".repeat(5000))).toBeNull();
  });
});

describe("kiVorschlagSpalten", () => {
  it("Name nach demselben Schema und Tag wie der finale — unveraendert uebernommen heisst gleicher Name", () => {
    const v = kiVorschlagKarte("lokal", { ordner: "00_ADMIN/01_Rechnungen", typ: "rechnung", betreff: "Licht", partei: "Herzog Tech", nummer: "R-12", dok_datum: "" });
    const s = kiVorschlagSpalten(v, "scan_001.PDF", HEUTE);
    const final = baueAblageName({ typKey: "rechnung", betreff: "Licht", partei: "Herzog Tech", nummer: "R-12", dokDatum: "" }, "scan_001.PDF", HEUTE);
    expect(s).toEqual({ ki_quelle: "lokal", ki_ordner: "00_ADMIN/01_Rechnungen", ki_name: final });
  });

  it("ohne Betreff kein Namensvorschlag (zaehlt als «Name geaendert»)", () => {
    expect(kiVorschlagSpalten(kiVorschlagKarte("claude", { typ: "rechnung", betreff: "" }), "a.pdf", HEUTE).ki_name).toBeNull();
  });
});

describe("leseSeiten", () => {
  it("nur ganze Seitenzahlen 1…100000 aus dem Ergebnis der lokalen KI", () => {
    expect(leseSeiten({ seiten: 12 })).toBe(12);
    expect(leseSeiten({ seiten: 0 })).toBeNull();
    expect(leseSeiten({ seiten: 2.5 })).toBeNull();
    expect(leseSeiten({ seiten: "3" })).toBeNull();
    expect(leseSeiten(null)).toBeNull();
  });
});
