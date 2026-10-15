import { describe, expect, it } from "vitest";
import { modellAnzeige, modellOrt, modellZustand } from "@/lib/technik-dashboard/konstanten";
import type { KiModellLast, KiPaket, RigPaket } from "@/lib/technik-dashboard/typen";
import { AUSSERHALB_TEXT, belegungGanz, belegungTeile, kiLage, modellZeile } from "./modelle";

const GIB = 1024 ** 3;

// Echte Zahlen vom Rig (15.10.2026, Messlauf): grosses Modell rechnet auf dem Prozessor.
const GROSS: KiModellLast = {
  instanz: "gruendlich", zustand: "geladen", name: "gemma4:26b-a4b-it-qat", rolle: "sprache",
  groesse_b: 15651370432, vram_b: 0, kontext: 16384, cpu_prozent: 997.3, rechnet: true, rss_b: 17952096256, ram_b: 17936297984,
};
const SCHNELL: KiModellLast = {
  instanz: "schnell", zustand: "geladen", name: "gemma3:4b", rolle: "sprache",
  groesse_b: 5 * GIB, vram_b: 5 * GIB, cpu_prozent: 0.4, rechnet: false, rss_b: 1.2 * GIB, ram_b: 0.9 * GIB,
};
const SUCHE: KiModellLast = { instanz: "schnell", zustand: "laedt", name: "bge-m3:latest", rolle: "einbettung" };

describe("modellAnzeige / modellOrt / modellZustand", () => {
  it("nennt Rolle nach Instanz und Groesse aus dem Namen", () => {
    expect(modellAnzeige(GROSS)).toBe("Grosses Modell (26B)");
    expect(modellAnzeige(SCHNELL)).toBe("Schnelles Modell (4B)");
    expect(modellAnzeige(SUCHE)).toBe("Suchmodell");
    expect(modellAnzeige({ instanz: "schnell", name: "qwen2.5vl:3b" })).toBe("Schnelles Modell (3B)");
    expect(modellAnzeige({ instanz: "gruendlich", name: "gemma4:12b-it-qat" })).toBe("Grosses Modell (12B)");
    expect(modellAnzeige({ instanz: "gruendlich" })).toBe("Grosses Modell");
  });

  it("zeigt den Ort ganz oder geteilt wie «ollama ps»", () => {
    expect(modellOrt(GROSS)).toBe("Prozessor");
    expect(modellOrt(SCHNELL)).toBe("Grafikkarte");
    expect(modellOrt({ groesse_b: 10 * GIB, vram_b: 6 * GIB })).toBe("60 % Grafikkarte / 40 % Prozessor");
    expect(modellOrt({ groesse_b: 1000, vram_b: 996 })).toBe("Grafikkarte");
    expect(modellOrt({ groesse_b: 1000, vram_b: 4 })).toBe("Prozessor");
    expect(modellOrt({ groesse_b: 1000 })).toBeNull();
    expect(modellOrt({})).toBeNull();
  });

  it("leitet den Zustand aus der Last ab", () => {
    expect(modellZustand(GROSS)).toBe("rechnet");
    expect(modellZustand(SCHNELL)).toBe("ruht");
    expect(modellZustand(SUCHE)).toBe("lädt");
    expect(modellZustand({ zustand: "geladen" })).toBe("geladen");
  });
});

describe("modellZeile", () => {
  it("baut die Zeile fuer «Jetzt gerade»", () => {
    expect(modellZeile(GROSS)).toBe("Grosses Modell (26B) · Prozessor · rechnet · 15 GB");
    expect(modellZeile(SCHNELL)).toBe("Schnelles Modell (4B) · Grafikkarte · ruht · 5,0 GB");
    expect(modellZeile(SUCHE)).toBe("Suchmodell · lädt");
  });
});

describe("kiLage", () => {
  const rig = (modelle?: KiModellLast[]) => ({ gemessen_am: "2026-10-15T20:47:00Z", ki_modelle: modelle }) as RigPaket;
  it("rechnet aus der Last, auch ohne Auftrag — mit Hinweis «ausserhalb»", () => {
    const l = kiLage(rig([GROSS, SCHNELL]), { auftrag: null, warteschlange: 0 });
    expect(l).toMatchObject({ rechnet: true, auftrag: false, ausserhalb: true, hintergrund: null });
    expect(AUSSERHALB_TEXT).toBe("rechnet ausserhalb der Warteschlange (z. B. Messung/Test)");
  });
  it("nennt die Hintergrundarbeit des Dienstes statt «ausserhalb»", () => {
    const l = kiLage(rig([GROSS]), { auftrag: null, hintergrund: "rueckstau_zz" } as KiPaket);
    expect(l).toMatchObject({ rechnet: true, ausserhalb: false, hintergrund: "Rückstau ZZ" });
  });
  it("Auftrag = rechnet, nie «ausserhalb»; ohne Last und Auftrag ruht die KI", () => {
    const auftrag = { art: "ablage_analyse", seit: "2026-10-15T20:46:00Z" };
    expect(kiLage(rig([GROSS]), { auftrag })).toMatchObject({ rechnet: true, auftrag: true, ausserhalb: false });
    expect(kiLage(rig([SCHNELL]), { auftrag: null, hintergrund: "tiefen_index" } as KiPaket))
      .toMatchObject({ rechnet: false, ausserhalb: false, hintergrund: null });
    expect(kiLage(rig(undefined), { auftrag })).toMatchObject({ rechnet: true, modelle: [] });
    expect(kiLage(null, null)).toMatchObject({ rechnet: false, auftrag: false, ausserhalb: false, modelle: [] });
  });
});

describe("belegungTeile", () => {
  const b = { ki_modelle_b: 18 * GIB, ki_rest_b: 0.3 * GIB, trustone_b: 11.5 * GIB, system_b: 2.6 * GIB, verfuegbar_b: 15.6 * GIB };
  it("teilt die KI-Modelle nach ihrem festen Speicher und geht genau auf", () => {
    const t = belegungTeile(b, [GROSS, SCHNELL, SUCHE]);
    expect(t.map((x) => x.name)).toEqual([
      "Grosses Modell (26B)", "Schnelles Modell (4B)", "Übriger KI-Bereich", "Trust one (Summe)", "System und Programme", "Verfügbar",
    ]);
    expect(t[0].rechnet).toBe(true);
    expect(t[0].b + t[1].b).toBeCloseTo(b.ki_modelle_b, 0);
    expect(belegungGanz(t)).toBeCloseTo(48 * GIB, 0);
  });
  it("ohne Prozess-Messung ein Teil «KI-Modelle», leere Teile fallen weg, verfuegbar bleibt", () => {
    const t = belegungTeile({ ...b, ki_rest_b: 0 }, [SUCHE]);
    expect(t.map((x) => x.art)).toEqual(["modell", "trustone", "system", "frei"]);
    expect(t[0].name).toBe("KI-Modelle");
    expect(belegungTeile({ ...b, ki_modelle_b: 0, ki_rest_b: 0, trustone_b: 0, system_b: 0 }, []).map((x) => x.art)).toEqual(["frei"]);
  });
});
