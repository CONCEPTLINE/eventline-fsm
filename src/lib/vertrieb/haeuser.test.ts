import { describe, expect, it } from "vitest";
import {
  anrufFolgen,
  erstmailsProWoche,
  filtereHaeuser,
  imGebiet,
  isoWoche,
  passtZurSuche,
  sortiereHaeuser,
  stufeInfo,
  tageZwischen,
  verteilungNachGebiet,
  wochenMontag,
  zaehleStufen,
} from "./haeuser";
import type { HausStufe, VertriebRaum } from "@/types/vertrieb";

function haus(name: string, stufe: HausStufe, extra: Partial<VertriebRaum> = {}): VertriebRaum {
  return {
    id: name, name, ort: null, ansprechperson: null, email: null, telefon: null, website: null,
    infos: null, erstmail: null, datum: null, aufgabe: null, dokumente: [], stufe,
    gebiet: "Basel-Stadt", prio: "B", gruppe: null, bedarf: null, bedarf_beleg: null,
    bedarf_belegt: false, created_at: "", updated_at: "", ...extra,
  };
}

describe("Stufen", () => {
  it("Rang steigt entlang der Pipeline, Absage/Pause liegen ausserhalb", () => {
    expect(stufeInfo("recherche").rang).toBeLessThan(stufeInfo("angeschrieben").rang);
    expect(stufeInfo("angeschrieben").rang).toBeLessThan(stufeInfo("partner").rang);
    expect(stufeInfo("absage").rang).toBe(-1);
    expect(stufeInfo("pause").rang).toBe(-1);
  });
});

describe("Gebiet und Suche", () => {
  it("«Weitere» fasst alles ausserhalb der drei Hauptgebiete", () => {
    expect(imGebiet({ gebiet: "Ring 2" }, "weitere")).toBe(true);
    expect(imGebiet({ gebiet: "Solothurn Nord" }, "weitere")).toBe(true);
    expect(imGebiet({ gebiet: null }, "weitere")).toBe(true);
    expect(imGebiet({ gebiet: "Fricktal" }, "weitere")).toBe(false);
    expect(imGebiet({ gebiet: "Fricktal" }, "Fricktal")).toBe(true);
    expect(imGebiet({ gebiet: "Fricktal" }, "alle")).toBe(true);
  });

  it("Suche ignoriert Gross/Klein und Umlaute, sucht in Name, Ort und Gruppe", () => {
    const h = { name: "Schützen Hotels", ort: "Rheinfelden", gruppe: null };
    expect(passtZurSuche(h, "schutzen")).toBe(true);
    expect(passtZurSuche(h, "RHEIN")).toBe(true);
    expect(passtZurSuche({ name: "Landgasthof Riehen", ort: "Riehen", gruppe: "Groupe Oniro" }, "oniro")).toBe(true);
    expect(passtZurSuche(h, "")).toBe(true);
    expect(passtZurSuche(h, "Tanzhaus")).toBe(false);
  });

  it("filtert Absage und Pause immer heraus", () => {
    const liste = [haus("A", "recherche"), haus("B", "absage"), haus("C", "pause"), haus("D", "angeschrieben")];
    expect(filtereHaeuser(liste, "alle", "").map((h) => h.name)).toEqual(["A", "D"]);
  });
});

describe("Zählung", () => {
  it("zählt je Stufe und gesamt, ohne Absage/Pause", () => {
    const z = zaehleStufen([haus("A", "recherche"), haus("B", "recherche"), haus("C", "angeschrieben"), haus("D", "absage")]);
    expect(z.alle).toBe(3);
    expect(z.recherche).toBe(2);
    expect(z.angeschrieben).toBe(1);
    expect(z.partner).toBe(0);
  });

  it("verteilt nach Gebiet in angeschrieben / vorbereitet / Recherche", () => {
    const v = verteilungNachGebiet([
      haus("A", "angeschrieben"), haus("B", "bedarf"), haus("C", "anruf"), haus("D", "recherche"),
      haus("E", "recherche", { gebiet: "Ring 2" }), haus("F", "absage"),
    ]);
    expect(v[0]).toEqual({ label: "Basel-Stadt", gesamt: 4, angeschrieben: 1, vorbereitet: 2, recherche: 1 });
    expect(v[3]).toMatchObject({ label: "Weitere", gesamt: 1, recherche: 1 });
  });
});

describe("Sortierung", () => {
  it("weiteste Stufe zuerst, dann Prio A, dann früheres Datum, ohne Datum ans Ende", () => {
    const s = sortiereHaeuser([
      haus("R", "recherche"),
      haus("Bspät", "angeschrieben", { datum: "2026-11-20" }),
      haus("Bohne", "angeschrieben"),
      haus("Bfrüh", "angeschrieben", { datum: "2026-11-16" }),
      haus("A", "angeschrieben", { prio: "A", datum: "2026-12-01" }),
      haus("G", "gespraech"),
    ]);
    expect(s.map((h) => h.name)).toEqual(["G", "A", "Bfrüh", "Bspät", "Bohne", "R"]);
  });
});

describe("Anruf erfassen", () => {
  it("Termin hebt auf «Im Gespräch», aber nie rückwärts", () => {
    expect(anrufFolgen("termin", "2026-11-09", "angeschrieben").stufe).toBe("gespraech");
    expect(anrufFolgen("termin", "2026-11-09", "partner").stufe).toBe("partner");
  });
  it("Rückruf setzt den nächsten Schritt eine Woche später, Stufe bleibt", () => {
    const f = anrufFolgen("rueckruf", "2026-11-09", "anruf");
    expect(f).toMatchObject({ stufe: "anruf", datum: "2026-11-16" });
  });
  it("Kein Bedarf = Absage ohne nächsten Schritt", () => {
    expect(anrufFolgen("kein_bedarf", "2026-11-09", "angeschrieben")).toMatchObject({ stufe: "absage", datum: null, aufgabe: null });
  });
});

describe("Wochen", () => {
  it("rechnet ISO-Kalenderwochen und Montage", () => {
    expect(isoWoche("2026-11-09").woche).toBe(46);
    expect(isoWoche("2026-11-08").woche).toBe(45);
    expect(isoWoche("2027-01-01")).toEqual({ jahr: 2026, woche: 53 });
    expect(wochenMontag("2026-11-15")).toBe("2026-11-09");
    expect(wochenMontag("2026-11-09")).toBe("2026-11-09");
  });

  it("zählt pro Haus nur die erste Mail", () => {
    const w = erstmailsProWoche([
      { haus_id: "oniro", datum: "2026-11-08", art: "mail" },
      { haus_id: "seegarten", datum: "2026-11-09", art: "mail" },
      { haus_id: "tanzhaus", datum: "2026-06-10", art: "mail" },
      { haus_id: "tanzhaus", datum: "2026-11-09", art: "mail" },
      { haus_id: "seegarten", datum: "2026-11-16", art: "mail" },
      { haus_id: "schuetzen", datum: "2026-11-09", art: "anruf" },
    ], "2026-11-02", 3);
    expect(w).toEqual([
      { montag: "2026-11-02", kw: 45, anzahl: 1 },
      { montag: "2026-11-09", kw: 46, anzahl: 1 },
      { montag: "2026-11-16", kw: 47, anzahl: 0 },
    ]);
  });

  it("Tage zwischen zwei Daten", () => {
    expect(tageZwischen("2026-11-09", "2026-12-04")).toBe(25);
    expect(tageZwischen("2026-11-09", "2027-12-15")).toBe(401);
  });
});
