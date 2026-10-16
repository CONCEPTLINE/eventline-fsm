import { describe, expect, it } from "vitest";
import { SELBSTTEST_LABEL, anteile, belegText, dauerKurz, pct, seitenText, trefferText, zweiterBlickText } from "./leistung-teil";

describe("Zweiter Blick", () => {
  const leer = { seit: null, vorschlaege: 0, offen: 0, ersetzt: 0, geaendert: 0, ordner_geaendert: 0, name_geaendert: 0 };

  it("ohne Daten keine Zeile; Rig + FSM zusammen", () => {
    expect(zweiterBlickText(undefined, leer)).toBeNull();
    const t = zweiterBlickText({ nachgelesen: 42, anders: 12, gleich: 30, entschieden: 2, zu_lang: 3, ms_median: 111_000 },
      { ...leer, vorschlaege: 12, ersetzt: 10, geaendert: 4, ordner_geaendert: 3, name_geaendert: 2 });
    expect(t?.wert).toBe("42 nachgelesen · 4 von 10 geändert");
    expect(t?.wie).toContain("42 Dokumente nachgelesen, 12 davon anders oder vollständiger beschrieben");
    expect(t?.wie).toContain("4 von 10 ersetzten Vorschlägen geändert (3× Ordner, 2× Name)");
    expect(t?.wie).toContain("2 weitere Vorschläge ohne Vergleich mit dem vorherigen");
    expect(t?.wie).toContain("1:51 min je Dokument");
    expect(t?.wie).toContain("3 Dokumente mit mehr als 5 Teilen bleiben beim schnellen Modell");
    const eins = zweiterBlickText({ nachgelesen: 1, anders: 1, gleich: 0, entschieden: 0, zu_lang: 1 }, { ...leer, vorschlaege: 1, ersetzt: 1 });
    expect(eins?.wie).toContain("1 Dokument mit mehr als 5 Teilen bleibt beim schnellen Modell");
  });

  it("ohne festgehaltenen Vorgänger kein «geändert», sondern «neue Vorschläge»", () => {
    const t = zweiterBlickText({ nachgelesen: 80, anders: 65, gleich: 15, entschieden: 0, zu_lang: 0 }, { ...leer, vorschlaege: 65, offen: 65 });
    expect(t?.wert).toBe("80 nachgelesen · 65 neue Vorschläge");
    expect(t?.wie).toContain("ohne Vergleich mit dem vorherigen Vorschlag");
    expect(t?.wie).not.toContain("ersetzten");
  });

  it("nur FSM-Zahlen (Rig-Auswertung noch nicht da): keine erfundene Null beim Nachlesen", () => {
    const t = zweiterBlickText(null, { ...leer, vorschlaege: 1, offen: 1 });
    expect(t?.wert).toBe("1 neuer Vorschlag");
    expect(t?.wie).not.toContain("nachgelesen");
  });
});

describe("Leistung: Anzeige-Helfer", () => {
  it("Dauer kurz mit sinnvollen Stellen", () => {
    expect(dauerKurz(59)).toBe("0,06 s");
    expect(dauerKurz(500)).toBe("0,5 s");
    expect(dauerKurz(670)).toBe("0,7 s");
    expect(dauerKurz(4355)).toBe("4,4 s");
    expect(dauerKurz(9_960)).toBe("10 s");
    expect(dauerKurz(16_075)).toBe("16 s");
    expect(dauerKurz(105_300)).toBe("1:45 min");
    expect(dauerKurz(54_187)).toBe("54 s");
    expect(dauerKurz(12 * 60_000)).toBe("12 min");
  });

  it("Anteile ergeben zusammen 100 %, auch bei Rundung", () => {
    expect(anteile([1, 1, 1])).toEqual([34, 33, 33]);
    expect(anteile([15, 6, 3])).toEqual([63, 25, 12]);
    expect(anteile([0, 0, 0])).toEqual([0, 0, 0]);
    expect(anteile([2, 0, 0])).toEqual([100, 0, 0]);
    expect(pct(0.45)).toBe("45 %");
    expect(pct(0.683)).toBe("68 %");
  });

  it("Rechenzeit je Seite und Groesse einer Auftragsart: nur was da ist, ein Teil/eine Seite ohne Angabe", () => {
    expect(seitenText({ art: "nacht_zz", n: 3, ok: 3, ms_seite_text: 1830, ms_seite_gescannt: 4100, seiten_max: 22, teile_max: 7 }))
      .toBe("je Seite 1,8 s Text, 4,1 s gescannt · bis 22 Seiten in bis zu 7 Teilen gelesen");
    expect(seitenText({ art: "ablage_analyse", n: 1, ok: 1, ms_seite_text: 900, seiten_max: 1, teile_max: 1 })).toBe("je Seite 0,9 s Text");
    expect(seitenText({ art: "nas_suche", n: 4, ok: 4 })).toBe("");
  });
});

describe("Belegquote", () => {
  it("Beschrieb gesamt und je Feld, Fristen getrennt, mit «wie gemessen»", () => {
    const t = belegText({ zz: 40, fristen: 21, felder: { datum: { angegeben: 20, belegt: 18 }, status: { angegeben: 5, belegt: 4 }, fristen: { angegeben: 6, belegt: 5 } } });
    expect(t.wert).toBe("88 % belegt");
    expect(t.wie).toContain("22 von 25 Angaben im Beschrieb belegt (40 Dateien) — Datum 90 %, Status 80 %");
    expect(t.wie).toContain("Fristen 5 von 6 belegt (21 Dokumente)");
    expect(t.wie).toContain("wörtlich im gelesenen Teil");
  });
  it("nur Fristen, oder noch keine Messung", () => {
    expect(belegText({ zz: 0, fristen: 3, felder: { fristen: { angegeben: 4, belegt: 1 } } }).wert).toBe("25 % der Fristen belegt");
    expect(belegText(undefined).wert).toBe("noch keine");
    expect(belegText({ zz: 2, fristen: 0, felder: {} }).wert).toBe("noch keine");
  });
});

describe("Wie oft die KI richtig liegt (Hauptzahl aus echten Entscheiden)", () => {
  const uploads = { seit: null, mit_vorschlag: 10, unveraendert: 6, ordner_geaendert: 2, name_geaendert: 3, quellen: { regel: 1, lokal: 2, claude: 7, beschrieb: 0 } };
  const zz = (logik: "claude" | "lokal", unveraendert: number, geaendert: number, ordner: number, abgelehnt: number) => ({
    logik, seit: null, vorschlaege: 0, offen: 0, unveraendert, geaendert, ordner_geaendert: ordner, name_geaendert: geaendert - ordner, abgelehnt,
    entscheid_von: null, entscheid_bis: null,
  });

  it("richtiger Ordner über App und Rückstau zusammen; Name geändert zählt als richtig, abgelehnt als falsch", () => {
    // App: 8 von 10 Ordner richtig. ZZ mit Claude: 5 unverändert + 3 geändert (davon 1× Ordner) + 2 abgelehnt → 7 von 10.
    const t = trefferText(uploads, [zz("claude", 5, 3, 1, 2)], "30d");
    expect(t.wert).toBe("75 % richtiger Ordner");
    expect(t.wie).toContain("15 von 20 Vorschlägen, über die ein Mensch entschieden hat");
    expect(t.wie).toContain("Ablage aus der App 80 % (10), Rückstau ZZ mit Claude 70 % (10)");
    expect(t.wie).toContain("Ordner und Name unverändert 55 %");
    expect(t.wie).toContain("Selbsttest unten misst nur den Rückfall ohne Claude");
  });

  it("Teile ohne Entscheid fallen weg; ohne jeden Entscheid «noch keine»", () => {
    const leer = { ...uploads, mit_vorschlag: 0, unveraendert: 0, ordner_geaendert: 0, name_geaendert: 0 };
    const t = trefferText(leer, [zz("lokal", 1, 0, 0, 0), zz("claude", 0, 0, 0, 0)], "7d");
    expect(t.wert).toBe("100 % richtiger Ordner");
    expect(t.wie).toContain("1 von 1 Vorschlag, über den ein Mensch entschieden hat");
    expect(t.wie).toContain("Rückstau ZZ nur lokal 100 % (1)");
    expect(t.wie).not.toContain("App");
    expect(trefferText(leer, [], "7d")).toEqual(expect.objectContaining({ wert: "noch keine" }));
    expect(trefferText(leer, [], "alle").wie).toMatch(/^Noch kein Entscheid/);
  });

  it("Selbsttest ehrlich beschriftet: lokale Ordnerwahl, Rückfall ohne Claude", () => {
    expect(SELBSTTEST_LABEL).toBe("Selbsttest lokale Ordnerwahl (Rückfall ohne Claude)");
  });
});
