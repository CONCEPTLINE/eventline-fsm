// «Fragen an dich»: Katalog-Regeln, neueste Antwort, offene Fragen.
import { describe, expect, it } from "vitest";
import { FRAGEN, frageNach, istFrageSchluessel, istGueltigeAntwort, neuesteAntworten, offeneFragen, type Frage } from "./katalog";

const P = "a0000000-0000-4000-8000-000000000011";
const AHV = frageNach("ahv_geringfuegig")!;

const zeile = (antwort: string, at: string, extra: Partial<{ text_version: string; frage_schluessel: string; profile_id: string }> = {}) => ({
  profile_id: P,
  frage_schluessel: "ahv_geringfuegig",
  antwort,
  text_version: "1.0",
  beantwortet_at: at,
  ...extra,
});

describe("Katalog", () => {
  it("Schlüssel und Optionswerte im Format der Datenbank (Migration 381), eindeutig", () => {
    expect(new Set(FRAGEN.map((f) => f.schluessel)).size).toBe(FRAGEN.length);
    for (const f of FRAGEN) {
      expect(istFrageSchluessel(f.schluessel)).toBe(true);
      expect(f.version.length).toBeGreaterThan(0);
      expect(f.optionen.length).toBeGreaterThanOrEqual(2);
      for (const o of f.optionen) expect(o.wert).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(new Set(f.optionen.map((o) => o.wert)).size).toBe(f.optionen.length);
    }
  });

  it("ahv_geringfuegig: Fassung 1.0, Optionen abziehen/keine, Text wie abgesprochen", () => {
    expect(AHV.version).toBe("1.0");
    expect(AHV.titel).toBe("AHV-Beiträge bei kleinem Lohn");
    expect(AHV.optionen).toEqual([
      { wert: "abziehen", label: "Beiträge abziehen" },
      { wert: "keine", label: "Keine Beiträge" },
    ]);
    const alles = [...AHV.text, ...AHV.punkte, AHV.warnung, AHV.hinweis].join(" ");
    expect(alles).toContain("höchstens CHF 2'500");
    expect(alles).toContain("Du kannst sie trotzdem zahlen.");
    expect(alles).toContain("Ohne Abzug: mehr Lohn auf die Hand.");
    expect(alles).toContain("fehlende Beitragsjahre kürzen sie später");
    expect(alles).toContain("auf den ganzen Jahreslohn geschuldet");
    expect(alles).toContain("nur für deinen Lohn bei EVENTLINE");
    expect(AHV.hinweis).toBe("Jederzeit änderbar unter Mein Konto.");
  });

  it("nur Optionen des Katalogs sind gültige Antworten", () => {
    expect(istGueltigeAntwort(AHV, "abziehen")).toBe(true);
    expect(istGueltigeAntwort(AHV, "keine")).toBe(true);
    expect(istGueltigeAntwort(AHV, "ja")).toBe(false);
    expect(istGueltigeAntwort(AHV, null)).toBe(false);
  });
});

describe("neueste Antwort und offene Fragen", () => {
  it("es gilt die neueste gültige Antwort; ungültige und unbekannte Fragen fallen weg", () => {
    const m = neuesteAntworten([
      zeile("abziehen", "2026-11-01T10:00:00Z"),
      zeile("keine", "2026-11-02T10:00:00Z"),
      zeile("quatsch", "2026-11-03T10:00:00Z"),
      zeile("keine", "2026-11-04T10:00:00Z", { frage_schluessel: "gibt_es_nicht" }),
    ]);
    expect(m.size).toBe(1);
    expect(m.get(`${P}|ahv_geringfuegig`)?.antwort).toBe("keine");
  });

  it("offen ohne Antwort, erledigt mit Antwort zur aktuellen Fassung, wieder offen bei neuer Fassung", () => {
    expect(offeneFragen([AHV], []).map((f) => f.schluessel)).toEqual(["ahv_geringfuegig"]);
    expect(offeneFragen([AHV], [zeile("keine", "2026-11-02T10:00:00Z")])).toEqual([]);
    const neu: Frage = { ...AHV, version: "1.1" };
    expect(offeneFragen([neu], [zeile("keine", "2026-11-02T10:00:00Z")]).map((f) => f.version)).toEqual(["1.1"]);
    // Neueste Antwort zählt: alte Fassung zuletzt beantwortet → offen.
    expect(offeneFragen([neu], [
      zeile("keine", "2026-11-02T10:00:00Z", { text_version: "1.1" }),
      zeile("abziehen", "2026-11-03T10:00:00Z", { text_version: "1.0" }),
    ])).toHaveLength(1);
  });
});
