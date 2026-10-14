import { describe, expect, it } from "vitest";
import { artLabel, beschreibeGrundlage, datumTon, fmtTag, ordnerVon, relativ, relativKurz, tageBis } from "./fristen-hilfen";

describe("fristen-hilfen", () => {
  it("fmtTag ohne Date-Umweg", () => {
    expect(fmtTag("2026-12-31")).toBe("31.12.2026");
    expect(fmtTag("kaputt")).toBe("kaputt");
  });

  it("tageBis / relativ / datumTon", () => {
    expect(tageBis("2026-10-12", "2026-10-12")).toBe(0);
    expect(tageBis("2027-01-01", "2026-12-31")).toBe(1);
    expect(relativ("2026-10-12", "2026-10-12")).toBe("heute");
    expect(relativ("2026-10-13", "2026-10-12")).toBe("morgen");
    expect(relativ("2026-10-24", "2026-10-12")).toBe("in 12 Tagen");
    expect(relativ("2026-10-11", "2026-10-12")).toBe("seit gestern vorbei");
    expect(relativ("2026-10-09", "2026-10-12")).toBe("seit 3 Tagen vorbei");
    expect(relativKurz("2026-10-24", "2026-10-12")).toBe("in 12 Tagen");
    expect(relativKurz("2026-10-11", "2026-10-12")).toBe("1 T. überfällig");
    expect(relativKurz("2026-10-09", "2026-10-12")).toBe("3 T. überfällig");
    expect(relativKurz("kaputt", "2026-10-12")).toBe("");
    expect(datumTon("2026-10-11", "2026-10-12")).toBe("rot");
    expect(datumTon("2026-11-11", "2026-10-12")).toBe("amber");
    expect(datumTon("2026-11-12", "2026-10-12")).toBe("neutral");
  });

  it("ordnerVon / artLabel", () => {
    expect(ordnerVon("A/B/c.pdf")).toBe("A/B");
    expect(ordnerVon("c.pdf")).toBe("");
    expect(artLabel("kuendigung")).toBe("Kündigung");
    expect(artLabel("unbekannt")).toBe("Frist");
  });

  it("beschreibeGrundlage: Bedingungen als Satz, nichts erfunden", () => {
    expect(
      beschreibeGrundlage({ beginn: "2024-01-01", ende: null, faellig: null, laufzeit_monate: 36, verlaengerung_monate: 12, kuendigungsfrist: { anzahl: 3, einheit: "monate" } }),
    ).toBe("Beginn 01.01.2024 · Laufzeit 36 Monate · verlängert sich um 12 Monate · Kündigungsfrist 3 Monate");
    expect(beschreibeGrundlage({ faellig: "2026-11-30" })).toBe("fällig 30.11.2026");
    expect(beschreibeGrundlage({ kuendigungsfrist: { anzahl: 1, einheit: "wochen" }, laufzeit_monate: 1 })).toBe("Laufzeit 1 Monat · Kündigungsfrist 1 Woche");
    expect(beschreibeGrundlage(null)).toBe("");
    expect(beschreibeGrundlage([1, 2])).toBe("");
    expect(beschreibeGrundlage({ kuendigungsfrist: { anzahl: 2, einheit: "jahre" } })).toBe("");
  });
});
