import { describe, expect, it } from "vitest";
import { faelligeErinnerungen, type FristFuerErinnerung } from "./fristen-erinnerung";

const HEUTE = "2026-10-12";
const f = (datum: string, erinnert: unknown = [], extra: Partial<FristFuerErinnerung> = {}): FristFuerErinnerung => ({
  id: "f1",
  pfad: "01_FINANZEN/02_Versicherungen/Police.pdf",
  bezeichnung: "Police.pdf",
  datum,
  erinnert,
  ...extra,
});

describe("faelligeErinnerungen (Stufen 30/7/0)", () => {
  it("Stufe 30 genau 30 Tage vorher, nicht 31", () => {
    expect(faelligeErinnerungen([f("2026-11-12")], HEUTE)).toHaveLength(0);
    const [r] = faelligeErinnerungen([f("2026-11-11")], HEUTE);
    expect(r).toMatchObject({ stufe: 30, tageBis: 30, erinnert: [30] });
  });

  it("Stufe 7 und 0, jede nur einmal", () => {
    expect(faelligeErinnerungen([f("2026-10-19", [30])], HEUTE)[0]).toMatchObject({ stufe: 7, erinnert: [30, 7] });
    expect(faelligeErinnerungen([f("2026-10-19", [30, 7])], HEUTE)).toHaveLength(0);
    expect(faelligeErinnerungen([f(HEUTE, [30, 7])], HEUTE)[0]).toMatchObject({ stufe: 0, tageBis: 0, erinnert: [30, 7, 0] });
    expect(faelligeErinnerungen([f(HEUTE, [30, 7, 0])], HEUTE)).toHaveLength(0);
  });

  it("spaet erfasst (5 Tage vorher): eine Mail mit Stufe 7, 30 gilt als erledigt", () => {
    const [r] = faelligeErinnerungen([f("2026-10-17")], HEUTE);
    expect(r).toMatchObject({ stufe: 7, tageBis: 5, erinnert: [30, 7] });
    // am Folgetag nichts mehr bis zur Stufe 0
    expect(faelligeErinnerungen([f("2026-10-17", r.erinnert)], "2026-10-13")).toHaveLength(0);
  });

  it("vergangene Fristen feuern nie", () => {
    expect(faelligeErinnerungen([f("2026-10-11")], HEUTE)).toHaveLength(0);
  });

  it("unbrauchbares erinnert wird als leer gelesen, Fremdwerte bleiben weg", () => {
    expect(faelligeErinnerungen([f("2026-10-19", null)], HEUTE)[0]).toMatchObject({ stufe: 7, erinnert: [30, 7] });
    expect(faelligeErinnerungen([f("2026-10-19", ["x", 30])], HEUTE)[0]).toMatchObject({ erinnert: [30, 7] });
  });

  it("Ort: Ordner, wenn die Bezeichnung der Dateiname ist, sonst der ganze Pfad", () => {
    expect(faelligeErinnerungen([f(HEUTE)], HEUTE)[0].ordner).toBe("01_FINANZEN/02_Versicherungen");
    const ki = f(HEUTE, [], { bezeichnung: "Kündigung · Muster AG" });
    expect(faelligeErinnerungen([ki], HEUTE)[0]).toMatchObject({ name: "Kündigung · Muster AG", ordner: "01_FINANZEN/02_Versicherungen/Police.pdf" });
    expect(faelligeErinnerungen([f(HEUTE, [], { pfad: null })], HEUTE)[0].ordner).toBe("");
  });

  it("Monats- und Jahreswechsel ohne Zeitzonen-Drift", () => {
    expect(faelligeErinnerungen([f("2027-01-01")], "2026-12-25")[0]).toMatchObject({ tageBis: 7, stufe: 7 });
    // Sommerzeit-Ende (25.10.2026) liegt im Fenster: trotzdem ganze Tage
    expect(faelligeErinnerungen([f("2026-11-01")], "2026-10-25")[0]).toMatchObject({ tageBis: 7 });
  });
});
