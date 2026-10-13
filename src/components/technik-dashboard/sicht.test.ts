import { describe, it, expect } from "vitest";
import { GERAET, fokusVon, geraetGedimmt, geraetVorschau, teilGedimmt } from "./sicht";

// Fokus-Modus der Szene (Mischa 2026-10-14): ein gewaehltes Bauteil hebt sich ab, der Rest wird gedimmt —
// nie doppelt (Geraet als Ganzes ODER Bauteile im selben Geraet).
describe("Technik-Dashboard — Fokus-Modus", () => {
  it("Fokus nur bei offenem Bauteil, nie bei Uebersicht oder Ereignissen", () => {
    expect(fokusVon({ sel: "gpu", offen: true })).toBe("gpu");
    expect(fokusVon({ sel: "gpu", offen: false })).toBeNull();
    expect(fokusVon({ sel: "uebersicht", offen: true })).toBeNull();
    expect(fokusVon({ sel: "ereignisse", offen: true })).toBeNull();
  });

  it("ohne Fokus ist nichts gedimmt", () => {
    for (const t of Object.keys(GERAET) as Array<keyof typeof GERAET>) {
      expect(teilGedimmt(null, t)).toBe(false);
      expect(geraetGedimmt(null, GERAET[t])).toBe(false);
    }
  });

  it("Fokus im Rig: andere Rig-Teile einzeln gedimmt, NAS und Strecken als Ganzes", () => {
    expect(teilGedimmt("gpu", "gpu")).toBe(false);
    expect(teilGedimmt("gpu", "cpu")).toBe(true);
    expect(teilGedimmt("gpu", "ki")).toBe(true);
    expect(geraetGedimmt("gpu", "rig")).toBe(false);
    expect(geraetGedimmt("gpu", "nas")).toBe(true);
    expect(geraetGedimmt("gpu", "app")).toBe(true);
    expect(geraetGedimmt("gpu", "ablage")).toBe(true);
    expect(geraetGedimmt("gpu", "backup")).toBe(true);
    // Teile im NAS dimmen nicht zusaetzlich (das NAS-Gehaeuse dimmt schon als Ganzes)
    expect(teilGedimmt("gpu", "nas")).toBe(false);
  });

  it("Fokus auf einer Strecke: nur diese bleibt hell", () => {
    expect(geraetGedimmt("ablage", "ablage")).toBe(false);
    expect(geraetGedimmt("ablage", "rig")).toBe(true);
    expect(geraetGedimmt("ablage", "nas")).toBe(true);
    expect(geraetGedimmt("app", "app")).toBe(false);
  });

  it("Hover-Vorschau hellt das ganze Geraet des Bauteils auf", () => {
    expect(geraetVorschau("cpu", "rig")).toBe(true);
    expect(geraetVorschau("cpu", "nas")).toBe(false);
    expect(geraetVorschau(null, "rig")).toBe(false);
  });
});
