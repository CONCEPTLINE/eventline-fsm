import { describe, expect, it } from "vitest";
import { anruferErlaubt, anruferFuersProtokoll, lenaTokenPruefen } from "@/lib/lena/auth";
import {
  INT4_MAX,
  faelligPruefen,
  parseAuftragNr,
  prioritaetPruefen,
  protokollEingabe,
  terminZeitenPruefen,
  textFeld,
  titelPruefen,
  zeitraumPruefen,
} from "@/lib/lena/eingabe";
import {
  TEXT,
  auftragArchiviertText,
  auftragNichtGefundenText,
  notizAbgelegtText,
  termineText,
  terminGespeichertText,
  todoGespeichertText,
  satz,
  vorlesbar,
} from "@/lib/lena/texte";
import { formatTag, formatZeitraum, parseZeitpunkt, zurichMitternacht, zurichTeile } from "@/lib/lena/zeit";

// «Jetzt» fest: Do 29.10.2026 13:00 Schweizer Zeit (Winterzeit, UTC+1).
const JETZT = Date.UTC(2026, 9, 29, 12, 0);
const utc = (s: string) => Date.parse(s);

describe("lenaTokenPruefen", () => {
  const SECRET = "a".repeat(40);
  it("ohne oder mit zu kurzem Secret: nicht konfiguriert (null)", () => {
    expect(lenaTokenPruefen(`Bearer ${SECRET}`, undefined)).toBeNull();
    expect(lenaTokenPruefen(`Bearer ${SECRET}`, "")).toBeNull();
    expect(lenaTokenPruefen("Bearer kurz", "kurz")).toBeNull();
    expect(lenaTokenPruefen(`Bearer ${"b".repeat(31)}`, "b".repeat(31))).toBeNull();
  });
  it("richtiger Token: true", () => {
    expect(lenaTokenPruefen(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(lenaTokenPruefen(`Bearer ${SECRET}`, `${SECRET}\n`)).toBe(true); // Secret mit Zeilenende aus env
  });
  it("falscher, fehlender oder anders geformter Token: false", () => {
    expect(lenaTokenPruefen(`Bearer ${"b".repeat(40)}`, SECRET)).toBe(false);
    expect(lenaTokenPruefen(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(lenaTokenPruefen(`Bearer ${SECRET.slice(1)}`, SECRET)).toBe(false);
    expect(lenaTokenPruefen(SECRET, SECRET)).toBe(false);
    expect(lenaTokenPruefen(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(lenaTokenPruefen(null, SECRET)).toBe(false);
    expect(lenaTokenPruefen("Bearer ", SECRET)).toBe(false);
  });
});

describe("anruferErlaubt", () => {
  it("ohne Header erlaubt (Hauptschutz ist der Token)", () => {
    expect(anruferErlaubt(null)).toBe(true);
  });
  it("Leos Nummer, auch mit Leerzeichen", () => {
    expect(anruferErlaubt("+41782049521")).toBe(true);
    expect(anruferErlaubt(" +41 78 204 95 21 ")).toBe(true);
  });
  it("jede andere Angabe abgelehnt (fail closed)", () => {
    expect(anruferErlaubt("")).toBe(false);
    expect(anruferErlaubt("+41790000000")).toBe(false);
    expect(anruferErlaubt("0782049521")).toBe(false);
    expect(anruferErlaubt("{{from}}")).toBe(false);
    expect(anruferErlaubt("+41782049521,+41790000000")).toBe(false);
  });
  it("Protokoll: ohne Leerzeichen, gekappt", () => {
    expect(anruferFuersProtokoll(null)).toBeNull();
    expect(anruferFuersProtokoll("+41 78 204 95 21")).toBe("+41782049521");
    expect(anruferFuersProtokoll("x".repeat(100))).toHaveLength(32);
  });
});

describe("parseAuftragNr", () => {
  it("Nicht-Ziffern fallen weg", () => {
    expect(parseAuftragNr("INT-26292")).toEqual({ art: "nummer", nummer: 26292 });
    expect(parseAuftragNr("int 26 292")).toEqual({ art: "nummer", nummer: 26292 });
    expect(parseAuftragNr(26292)).toEqual({ art: "nummer", nummer: 26292 });
    expect(parseAuftragNr("000123")).toEqual({ art: "nummer", nummer: 123 });
  });
  it("int4-Grenze: groesser = unbekannt (keine DB-Abfrage)", () => {
    expect(parseAuftragNr(String(INT4_MAX))).toEqual({ art: "nummer", nummer: INT4_MAX });
    expect(parseAuftragNr(String(INT4_MAX + 1))).toEqual({ art: "unbekannt" });
    expect(parseAuftragNr(INT4_MAX + 1)).toEqual({ art: "unbekannt" });
    expect(parseAuftragNr("+41 78 204 95 21")).toEqual({ art: "unbekannt" });
    expect(parseAuftragNr("9".repeat(30))).toEqual({ art: "unbekannt" });
  });
  it("fehlt / ungueltig", () => {
    expect(parseAuftragNr(undefined)).toEqual({ art: "fehlt" });
    expect(parseAuftragNr(null)).toEqual({ art: "fehlt" });
    expect(parseAuftragNr("")).toEqual({ art: "fehlt" });
    expect(parseAuftragNr("INT-")).toEqual({ art: "fehlt" });
    expect(parseAuftragNr("0")).toEqual({ art: "unbekannt" });
    expect(parseAuftragNr(1.5)).toEqual({ art: "unbekannt" });
    expect(parseAuftragNr(-5)).toEqual({ art: "unbekannt" });
    expect(parseAuftragNr({ nr: 1 })).toEqual({ art: "unbekannt" });
    expect(parseAuftragNr("1".repeat(41))).toEqual({ art: "unbekannt" });
  });
});

describe("parseZeitpunkt (Schweizer Zeit)", () => {
  it("Datum ohne Uhrzeit = Beginn des Schweizer Tages", () => {
    expect(parseZeitpunkt("2026-10-30")).toEqual({ ms: utc("2026-10-29T23:00:00Z"), nurDatum: true, datum: "2026-10-30" });
    expect(parseZeitpunkt("2026-07-01")?.ms).toBe(utc("2026-06-30T22:00:00Z"));
  });
  it("Uhrzeit ohne Zeitzone = Schweizer Wandzeit (Winter/Sommer)", () => {
    expect(parseZeitpunkt("2026-10-30T10:00")?.ms).toBe(utc("2026-10-30T09:00:00Z"));
    expect(parseZeitpunkt("2026-07-01T10:00:00")?.ms).toBe(utc("2026-07-01T08:00:00Z"));
    expect(parseZeitpunkt("2026-10-30 10:00")?.ms).toBe(utc("2026-10-30T09:00:00Z"));
  });
  it("mit Zeitzone = genau dieser Zeitpunkt", () => {
    expect(parseZeitpunkt("2026-10-30T09:00:00Z")?.ms).toBe(utc("2026-10-30T09:00:00Z"));
    expect(parseZeitpunkt("2026-10-30T10:00:00+01:00")?.ms).toBe(utc("2026-10-30T09:00:00Z"));
    expect(parseZeitpunkt("2026-10-30T10:00:00.000+0100")?.ms).toBe(utc("2026-10-30T09:00:00Z"));
    expect(parseZeitpunkt("2026-10-30T23:30:00Z")?.datum).toBe("2026-10-31");
  });
  it("Umstellungstage", () => {
    // 29.03.2026: 02:00 → 03:00 (Luecke) — 02:30 gibt es nicht, ergibt 03:30 Sommerzeit.
    expect(parseZeitpunkt("2026-03-29T02:30")?.ms).toBe(utc("2026-03-29T01:30:00Z"));
    expect(parseZeitpunkt("2026-03-29T03:30")?.ms).toBe(utc("2026-03-29T01:30:00Z"));
    // 25.10.2026: 03:00 → 02:00 (doppelte Stunde) — die zweite (Winterzeit).
    expect(parseZeitpunkt("2026-10-25T02:30")?.ms).toBe(utc("2026-10-25T01:30:00Z"));
    expect(parseZeitpunkt("2026-10-25T12:00")?.ms).toBe(utc("2026-10-25T11:00:00Z"));
  });
  it("Unsinn → null", () => {
    for (const x of ["", "gestern", "30.10.2026", "2026-02-30", "2026-13-01", "2026-10-30T25:00", "2026-10-30T10:60", "1999-01-01", "2026-10-30T10:00+15:00", 20261030, null, {}]) {
      expect(parseZeitpunkt(x)).toBeNull();
    }
  });
});

describe("Zuerich-Formatierung", () => {
  it("«Fr 30.10. 10:00–11:00»", () => {
    expect(formatZeitraum(utc("2026-10-30T09:00:00Z"), utc("2026-10-30T10:00:00Z"), JETZT)).toBe("Fr 30.10. 10:00–11:00");
  });
  it("ohne Ende nur Beginn", () => {
    expect(formatZeitraum(utc("2026-10-30T09:00:00Z"), null, JETZT)).toBe("Fr 30.10. 10:00");
    expect(formatZeitraum(utc("2026-10-30T09:00:00Z"), utc("2026-10-30T09:00:00Z"), JETZT)).toBe("Fr 30.10. 10:00");
  });
  it("ueber Mitternacht mit zweitem Tag", () => {
    expect(formatZeitraum(utc("2026-10-30T21:00:00Z"), utc("2026-10-31T01:00:00Z"), JETZT)).toBe("Fr 30.10. 22:00 – Sa 31.10. 02:00");
  });
  it("Sommerzeit und anderes Jahr", () => {
    expect(formatZeitraum(utc("2026-07-01T06:30:00Z"), utc("2026-07-01T07:00:00Z"), JETZT)).toBe("Mi 01.07. 08:30–09:00");
    expect(formatTag(utc("2027-10-30T09:00:00Z"), JETZT)).toBe("Sa 30.10.2027");
  });
  it("Mitternacht kurz nach UTC-Tageswechsel bleibt Schweizer Tag", () => {
    expect(zurichTeile(utc("2026-10-29T23:30:00Z")).datum).toBe("2026-10-30");
    expect(zurichMitternacht("2026-10-30")).toBe(utc("2026-10-29T23:00:00Z"));
  });
});

describe("zeitraumPruefen", () => {
  it("ein Tag, bis fehlt → ganzer Tag", () => {
    const r = zeitraumPruefen("2026-10-30", undefined, JETZT);
    expect(r).toEqual({ ok: true, wert: { vonMs: utc("2026-10-29T23:00:00Z"), bisExklMs: utc("2026-10-30T23:00:00Z"), gekuerzt: false } });
  });
  it("bis als Datum ist inklusiv", () => {
    const r = zeitraumPruefen("2026-10-30", "2026-11-01", JETZT);
    expect(r.ok && r.wert.bisExklMs).toBe(utc("2026-11-01T23:00:00Z"));
  });
  it("mehr als 14 Tage → auf 14 Tage ab von gekuerzt", () => {
    const r = zeitraumPruefen("2026-10-30", "2026-12-31", JETZT);
    expect(r).toEqual({ ok: true, wert: { vonMs: utc("2026-10-29T23:00:00Z"), bisExklMs: utc("2026-11-12T23:00:00Z"), gekuerzt: true } });
    const genau = zeitraumPruefen("2026-10-30", "2026-11-12", JETZT);
    expect(genau.ok && genau.wert.gekuerzt).toBe(false);
  });
  it("mit Uhrzeiten", () => {
    const r = zeitraumPruefen("2026-10-30T08:00", "2026-10-30T12:00", JETZT);
    expect(r).toEqual({ ok: true, wert: { vonMs: utc("2026-10-30T07:00:00Z"), bisExklMs: utc("2026-10-30T11:00:00Z"), gekuerzt: false } });
  });
  it("Fehler mit vorlesbarem Text", () => {
    expect(zeitraumPruefen(undefined, undefined, JETZT)).toEqual({ ok: false, text: TEXT.datumFehlt });
    expect(zeitraumPruefen("morgen", undefined, JETZT)).toEqual({ ok: false, text: TEXT.datumUnklar });
    expect(zeitraumPruefen("2026-10-30", "irgendwann", JETZT)).toEqual({ ok: false, text: TEXT.endeUnklar });
    expect(zeitraumPruefen("2026-10-30", "2026-10-29", JETZT)).toEqual({ ok: false, text: TEXT.endeVorAnfang });
    expect(zeitraumPruefen("2024-10-30", undefined, JETZT)).toEqual({ ok: false, text: TEXT.zeitraumZuWeit });
    expect(zeitraumPruefen("2029-10-30", undefined, JETZT)).toEqual({ ok: false, text: TEXT.zeitraumZuWeit });
  });
  it("Vergangenheit bis ein Jahr ist erlaubt", () => {
    expect(zeitraumPruefen("2026-10-28", undefined, JETZT).ok).toBe(true);
  });
});

describe("terminZeitenPruefen", () => {
  it("ohne Ende → 1 Stunde", () => {
    expect(terminZeitenPruefen("2026-10-30T10:00", undefined, JETZT)).toEqual({
      ok: true,
      wert: { startMs: utc("2026-10-30T09:00:00Z"), endeMs: utc("2026-10-30T10:00:00Z") },
    });
  });
  it("heute frueher ist erlaubt, gestern nicht", () => {
    expect(terminZeitenPruefen("2026-10-29T08:00", undefined, JETZT).ok).toBe(true);
    expect(terminZeitenPruefen("2026-10-28T23:30", undefined, JETZT)).toEqual({ ok: false, text: TEXT.terminVergangen });
    expect(terminZeitenPruefen("2025-10-30T10:00", undefined, JETZT)).toEqual({ ok: false, text: TEXT.terminVergangen });
  });
  it("Fehler", () => {
    expect(terminZeitenPruefen(undefined, undefined, JETZT)).toEqual({ ok: false, text: TEXT.startFehlt });
    expect(terminZeitenPruefen("2026-10-30", undefined, JETZT)).toEqual({ ok: false, text: TEXT.uhrzeitFehlt });
    expect(terminZeitenPruefen("2026-10-30T10:00", "2026-10-30T09:00", JETZT)).toEqual({ ok: false, text: TEXT.endeVorAnfang });
    expect(terminZeitenPruefen("2026-10-30T10:00", "2026-10-30T10:00", JETZT)).toEqual({ ok: false, text: TEXT.endeVorAnfang });
    expect(terminZeitenPruefen("2026-10-30T10:00", "2026-10-31", JETZT)).toEqual({ ok: false, text: TEXT.endeUhrzeitFehlt });
    expect(terminZeitenPruefen("2026-10-30T10:00", "2026-11-07T10:01", JETZT)).toEqual({ ok: false, text: TEXT.terminZuLang });
    expect(terminZeitenPruefen("2029-10-30T10:00", undefined, JETZT)).toEqual({ ok: false, text: TEXT.terminZuWeit });
    expect(terminZeitenPruefen("30.10. 10 Uhr", undefined, JETZT)).toEqual({ ok: false, text: TEXT.datumUnklar });
  });
});

describe("To-do-Felder", () => {
  it("faellig_am", () => {
    expect(faelligPruefen(undefined, JETZT)).toEqual({ ok: true, wert: null });
    expect(faelligPruefen("2026-10-29", JETZT)).toEqual({ ok: true, wert: { datum: "2026-10-29", ms: utc("2026-10-28T23:00:00Z") } });
    expect(faelligPruefen("2026-10-28", JETZT)).toEqual({ ok: false, text: TEXT.faelligVergangen });
    expect(faelligPruefen("2026-02-30", JETZT)).toEqual({ ok: false, text: TEXT.faelligUnklar });
    expect(faelligPruefen("2026-10-30T10:00", JETZT)).toEqual({ ok: false, text: TEXT.faelligUnklar });
    expect(faelligPruefen("2029-01-01", JETZT)).toEqual({ ok: false, text: TEXT.faelligZuWeit });
    expect(faelligPruefen(20261030, JETZT)).toEqual({ ok: false, text: TEXT.faelligUnklar });
  });
  it("prioritaet", () => {
    expect(prioritaetPruefen(undefined)).toEqual({ ok: true, wert: "normal" });
    expect(prioritaetPruefen(" Dringend ")).toEqual({ ok: true, wert: "dringend" });
    expect(prioritaetPruefen("hoch")).toEqual({ ok: false, text: TEXT.prioritaetUnklar });
    expect(prioritaetPruefen(1)).toEqual({ ok: false, text: TEXT.prioritaetUnklar });
  });
  it("Titel und Freitext", () => {
    expect(titelPruefen("  Offerte \n schicken ")).toEqual({ ok: true, wert: "Offerte schicken" });
    expect(titelPruefen("   ")).toEqual({ ok: false, text: TEXT.titelFehlt });
    expect(titelPruefen(undefined)).toEqual({ ok: false, text: TEXT.titelFehlt });
    expect(titelPruefen("x".repeat(201))).toEqual({ ok: false, text: TEXT.titelZuLang });
    expect(textFeld("Zeile 1\r\n\r\n\r\n  Zeile\t2 ", 100, true)).toEqual({ art: "ok", wert: "Zeile 1\n\nZeile 2" });
    expect(textFeld("a\u0000b", 10)).toEqual({ art: "ok", wert: "a b" });
    expect(textFeld(["x"], 10)).toEqual({ art: "leer" });
  });
});

describe("Antworttexte", () => {
  const von = utc("2026-10-29T23:00:00Z");
  const bisEinTag = utc("2026-10-30T23:00:00Z");
  it("keine Termine", () => {
    expect(termineText({ termine: [], mehr: false, vonMs: von, bisExklMs: bisEinTag, gekuerzt: false, jetztMs: JETZT })).toBe(
      "Du hast am Fr 30.10. keine Termine.",
    );
  });
  it("ein und mehrere Termine", () => {
    const t = [{ zeit: "Fr 30.10. 10:00–11:00", titel: "Besichtigung" }];
    expect(termineText({ termine: t, mehr: false, vonMs: von, bisExklMs: bisEinTag, gekuerzt: false, jetztMs: JETZT })).toBe(
      "Du hast am Fr 30.10. einen Termin: Fr 30.10. 10:00–11:00, Besichtigung.",
    );
    const zwei = [...t, { zeit: "Sa 31.10. 09:00", titel: "Aufbau" }];
    expect(
      termineText({ termine: zwei, mehr: false, vonMs: von, bisExklMs: utc("2026-10-31T23:00:00Z"), gekuerzt: false, jetztMs: JETZT }),
    ).toBe("Du hast vom Fr 30.10. bis Sa 31.10. 2 Termine: Fr 30.10. 10:00–11:00, Besichtigung; Sa 31.10. 09:00, Aufbau.");
  });
  it("gekuerzt und mehr als 10", () => {
    const zehn = Array.from({ length: 10 }, () => ({ zeit: "Fr 30.10. 10:00", titel: "X" }));
    const text = termineText({ termine: zehn, mehr: true, vonMs: von, bisExklMs: utc("2026-11-12T23:00:00Z"), gekuerzt: true, jetztMs: JETZT });
    expect(text.endsWith("X.")).toBe(true);
    const anfang = "Ich schaue höchstens 14 Tage an, also bis Do 12.11. Du hast vom Fr 30.10. bis Do 12.11. mehr als 10 Termine. Die ersten 10: ";
    expect(text.slice(0, anfang.length)).toBe(anfang);
  });
  it("Speichern-Bestaetigungen", () => {
    expect(terminGespeichertText({ titel: "Besichtigung", zeit: "Fr 30.10. 10:00–11:00" })).toBe(
      "Termin gespeichert: «Besichtigung», Fr 30.10. 10:00–11:00.",
    );
    expect(
      terminGespeichertText({ titel: "Besichtigung", zeit: "Fr 30.10. 10:00–11:00", auftrag: { nummer: 26292, titel: "Firmenfest" } }),
    ).toBe("Termin gespeichert: «Besichtigung», Fr 30.10. 10:00–11:00, bei INT-26292 «Firmenfest».");
    expect(terminGespeichertText({ titel: "B", zeit: "Fr 30.10. 10:00", schonVorhanden: true })).toBe(
      "Der Termin war schon gespeichert: «B», Fr 30.10. 10:00.",
    );
    expect(todoGespeichertText({ titel: "Offerte schicken", dringend: false, jetztMs: JETZT })).toBe("To-do gespeichert: «Offerte schicken».");
    expect(
      todoGespeichertText({ titel: "Offerte schicken", faelligMs: utc("2026-10-29T23:00:00Z"), dringend: true, jetztMs: JETZT }),
    ).toBe("To-do gespeichert: «Offerte schicken», fällig am Fr 30.10., dringend.");
    expect(
      todoGespeichertText({ titel: "Offerte schicken", faelligMs: utc("2026-10-29T23:00:00Z"), dringend: false, jetztMs: JETZT }),
    ).toBe("To-do gespeichert: «Offerte schicken», fällig am Fr 30.10.");
    expect(satz("bis Do 12.11.")).toBe("bis Do 12.11.");
    expect(satz("Termin mit Dr")).toBe("Termin mit Dr.");
    expect(notizAbgelegtText({ nummer: 26292, jobTitel: "Firmenfest" })).toBe("Notiz bei INT-26292 «Firmenfest» abgelegt.");
  });
  it("Auftrag nicht gefunden / archiviert verraten nur die Nummer", () => {
    expect(auftragNichtGefundenText(26292)).toBe("Ich habe keinen Auftrag INT-26292 gefunden.");
    expect(auftragNichtGefundenText(null)).toBe("Einen Auftrag mit dieser Nummer habe ich nicht gefunden.");
    expect(auftragArchiviertText(26292)).toContain("INT-26292 ist archiviert");
  });
  it("vorlesbar: eine Zeile, gekappt", () => {
    expect(vorlesbar(" Fest\n\tGrossbasel ")).toBe("Fest Grossbasel");
    expect(vorlesbar(null)).toBe("");
    expect(vorlesbar("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("protokollEingabe (Datensparsamkeit)", () => {
  it("Notiz: nur Nummer und Laenge, nie der Text", () => {
    const e = protokollEingabe("auftrag-notiz", { auftrag_nr: "INT-26292", text: "Kunde will 2 Mikrofone, Tel 079 …" });
    expect(e).toEqual({ auftrag_nr: "INT-26292", text_laenge: 33 });
    expect(JSON.stringify(e)).not.toContain("Mikrofone");
  });
  it("Titel gekuerzt, Beschreibung nur als Laenge", () => {
    const e = protokollEingabe("todo-erstellen", { titel: "T".repeat(100), beschreibung: "geheim", prioritaet: "dringend" });
    expect(e.titel).toHaveLength(40);
    expect(e.titel_laenge).toBe(100);
    expect(e.beschreibung_laenge).toBe(6);
    expect(JSON.stringify(e)).not.toContain("geheim");
  });
  it("fremde Felder werden nicht uebernommen", () => {
    const e = protokollEingabe("termine-abfragen", { von: "2026-10-30", bis: { x: 1 }, passwort: "x" });
    expect(e).toEqual({ von: "2026-10-30", bis: null });
  });
});
