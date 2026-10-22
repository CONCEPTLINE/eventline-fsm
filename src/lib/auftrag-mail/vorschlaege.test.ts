import { describe, expect, it } from "vitest";
import { abgleichVorschlaege, datenAusText, vorschlaegeZusammen, type VorschlagKandidat } from "./vorschlaege";

const k = (p: Partial<VorschlagKandidat>): VorschlagKandidat => ({
  id: "j1",
  job_number: 26001,
  title: null,
  start_date: null,
  end_date: null,
  kunde: null,
  kunde_email: null,
  location: null,
  raum: null,
  ...p,
});

describe("datenAusText", () => {
  it("erkennt numerische und ausgeschriebene Daten", () => {
    expect(datenAusText("am 18.12.2026 und 3.1.27", "2026-10-22").sort()).toEqual(["2026-12-18", "2027-01-03"]);
    expect(datenAusText("Konzert am 18. Dezember 2026", "2026-10-22")).toEqual(["2026-12-18"]);
  });
  it("ohne Jahr: naechstes Vorkommen", () => {
    expect(datenAusText("Samstag 31. Oktober", "2026-10-22")).toEqual(["2026-10-31"]);
    expect(datenAusText("am 5. März", "2026-10-22")).toEqual(["2027-03-05"]);
  });
});

describe("abgleichVorschlaege", () => {
  const heute = "2026-10-22";
  it("Datum + Location ergeben einen Vorschlag mit Begruendung", () => {
    const v = abgleichVorschlaege(
      { betreff: "Konzert im Stadtcasino Basel am 18. Dezember 2026", text: "" },
      [
        k({ id: "a", start_date: "2026-12-18", location: "Stadtcasino Basel" }),
        k({ id: "b", start_date: "2026-11-02", location: "Volkshaus" }),
      ],
      heute,
    );
    expect(v.map((x) => x.job_id)).toEqual(["a"]);
    expect(v[0].grund).toContain("Datum 18.12.2026");
    expect(v[0].grund).toContain("Stadtcasino");
    expect(v[0].quelle).toBe("abgleich");
  });
  it("mehrtaegiger Auftrag: Datum im Zeitraum zaehlt", () => {
    const v = abgleichVorschlaege({ betreff: "Aufbau 13.11.2026", text: "" }, [k({ id: "a", start_date: "2026-11-12", end_date: "2026-11-14" })], heute);
    expect(v.map((x) => x.job_id)).toEqual(["a"]);
  });
  it("ein einzelnes schwaches Merkmal reicht nicht", () => {
    expect(abgleichVorschlaege({ betreff: "Frage Volkshaus", text: "" }, [k({ location: "Volkshaus" })], heute)).toEqual([]);
  });
  it("hoechstens 3, beste zuerst", () => {
    const viele = Array.from({ length: 6 }, (_, i) => k({ id: `j${i}`, start_date: "2026-12-18", location: i === 4 ? "Stadtcasino" : null }));
    const v = abgleichVorschlaege({ betreff: "18.12.2026 Stadtcasino", text: "" }, viele, heute);
    expect(v).toHaveLength(3);
    expect(v[0].job_id).toBe("j4");
  });
});

describe("vorschlaegeZusammen", () => {
  it("Prioritaet nach Liste, ohne Doppelte, max", () => {
    const v = vorschlaegeZusammen(
      [
        [{ job_id: "a", grund: "Verlauf", quelle: "verlauf" }],
        [{ job_id: "a", grund: "KI", quelle: "ki" }, { job_id: "b", grund: "KI", quelle: "ki" }],
        [{ job_id: "c", grund: "x", quelle: "abgleich" }, { job_id: "d", grund: "x", quelle: "abgleich" }],
      ],
      3,
    );
    expect(v.map((x) => `${x.job_id}:${x.quelle}`)).toEqual(["a:verlauf", "b:ki", "c:abgleich"]);
  });
});
