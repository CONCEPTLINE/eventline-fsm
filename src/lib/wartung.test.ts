import { describe, expect, it, vi } from "vitest";
import {
  KEINE_WARTUNG,
  WARTUNG_MELDUNG,
  erstelleWartungsCache,
  istWartungBereich,
  normalisiereWartung,
  wartungBereichFuerRecht,
  wartungBereicheText,
  wartungZugaenge,
  wartungZugang,
  type WartungStand,
} from "./wartung";

const MISCHA = "a0000000-0000-4000-8000-000000000002";
const LEO = "a0000000-0000-4000-8000-000000000001";

const stand = (bereiche: WartungStand["bereiche"], ausnahmen: string[] = []): WartungStand => ({
  bereiche,
  grund: bereiche.length ? "Umbau" : null,
  seit: bereiche.length ? "2026-10-29T14:00:00Z" : null,
  ausnahmen,
});

describe("Meldung", () => {
  it("ist wortgleich wie gewünscht (Hinweisseite + 503-Toast)", () => {
    expect(WARTUNG_MELDUNG).toBe(
      "Diese Funktion ist im Moment wegen Umbauten nicht möglich. Bitte Mischa Dittus kontaktieren: mischa@eventline-basel.com · 079 614 93 83",
    );
  });
});

describe("wartungZugang", () => {
  it("ohne Wartung frei — für alle, auch ohne Profil", () => {
    expect(wartungZugang(KEINE_WARTUNG, "lohn", LEO)).toBe("frei");
    expect(wartungZugang(KEINE_WARTUNG, "lohn", null)).toBe("frei");
  });
  it("Bereich in Wartung: gesperrt, Ausnahme arbeitet", () => {
    const s = stand(["lohn"], [MISCHA]);
    expect(wartungZugang(s, "lohn", LEO)).toBe("gesperrt");
    expect(wartungZugang(s, "lohn", MISCHA)).toBe("ausnahme");
  });
  it("andere Bereiche bleiben frei", () => {
    const s = stand(["lohn"], [MISCHA]);
    expect(wartungZugang(s, "rechte", LEO)).toBe("frei");
    expect(wartungZugang(s, "finanzen", MISCHA)).toBe("frei");
  });
  it("ohne Profil (System, nicht angemeldet) keine Ausnahme", () => {
    const s = stand(["geraete"], [MISCHA]);
    expect(wartungZugang(s, "geraete", null)).toBe("gesperrt");
    expect(wartungZugang(s, "geraete", undefined)).toBe("gesperrt");
    expect(wartungZugang(s, "geraete", "")).toBe("gesperrt");
  });
  it("wartungZugaenge liefert alle Bereiche", () => {
    expect(wartungZugaenge(stand(["lohn", "finanzen"]), LEO)).toEqual({
      lohn: "gesperrt",
      rechte: "frei",
      geraete: "frei",
      finanzen: "gesperrt",
    });
  });
});

describe("normalisiereWartung", () => {
  it("fehlende Zeile = keine Wartung", () => {
    expect(normalisiereWartung(null)).toEqual(KEINE_WARTUNG);
    expect(normalisiereWartung(undefined)).toEqual(KEINE_WARTUNG);
  });
  it("Unbekanntes fällt weg, feste Reihenfolge, keine Doppel", () => {
    const s = normalisiereWartung({
      bereiche: ["finanzen", "x", "lohn", "lohn"],
      grund: "  Umstellung  ",
      seit: "2026-10-29T14:00:00Z",
      ausnahmen: [MISCHA, MISCHA, 5, null, ""],
    });
    expect(s).toEqual({ bereiche: ["lohn", "finanzen"], grund: "Umstellung", seit: "2026-10-29T14:00:00Z", ausnahmen: [MISCHA] });
  });
  it("ohne Bereiche weder Grund noch seit", () => {
    expect(normalisiereWartung({ bereiche: [], grund: "alt", seit: "2026-10-29T14:00:00Z", ausnahmen: [] })).toEqual({
      bereiche: [],
      grund: null,
      seit: null,
      ausnahmen: [],
    });
  });
  it("kaputte Typen werfen nicht", () => {
    expect(normalisiereWartung({ bereiche: "lohn", grund: 3, seit: {}, ausnahmen: "x" })).toEqual(KEINE_WARTUNG);
  });
});

describe("Hilfen", () => {
  it("Recht → Bereich", () => {
    expect(wartungBereichFuerRecht("lohn:manage")).toBe("lohn");
    expect(wartungBereichFuerRecht("finanzen:view")).toBe("finanzen");
    expect(wartungBereichFuerRecht("kunden:archive")).toBeNull();
  });
  it("istWartungBereich", () => {
    expect(istWartungBereich("geraete")).toBe(true);
    expect(istWartungBereich("Lohn")).toBe(false);
    expect(istWartungBereich(null)).toBe(false);
  });
  it("Bereichstext", () => {
    expect(wartungBereicheText(["lohn", "geraete"])).toBe("Lohn, Geräte");
  });
});

describe("erstelleWartungsCache", () => {
  function aufbau(ttlMs = 10_000) {
    let t = 1_000;
    const laden = vi.fn<() => Promise<WartungStand>>();
    const beiFehler = vi.fn();
    const cache = erstelleWartungsCache(laden, { ttlMs, jetzt: () => t, beiFehler });
    return { cache, laden, beiFehler, vor: (ms: number) => (t += ms) };
  }

  it("liest innerhalb der TTL nur einmal, danach neu", async () => {
    const { cache, laden, vor } = aufbau();
    laden.mockResolvedValueOnce(stand(["lohn"])).mockResolvedValueOnce(KEINE_WARTUNG);
    expect((await cache.lesen()).bereiche).toEqual(["lohn"]);
    vor(9_999);
    expect((await cache.lesen()).bereiche).toEqual(["lohn"]);
    expect(laden).toHaveBeenCalledTimes(1);
    vor(1);
    expect((await cache.lesen()).bereiche).toEqual([]);
    expect(laden).toHaveBeenCalledTimes(2);
  });

  it("gleichzeitige Aufrufe teilen sich ein Laden", async () => {
    const { cache, laden } = aufbau();
    laden.mockResolvedValue(stand(["rechte"]));
    const [a, b] = await Promise.all([cache.lesen(), cache.lesen()]);
    expect(a).toBe(b);
    expect(laden).toHaveBeenCalledTimes(1);
  });

  it("frisch und leeren lesen sofort neu", async () => {
    const { cache, laden } = aufbau();
    laden.mockResolvedValueOnce(KEINE_WARTUNG).mockResolvedValueOnce(stand(["lohn"])).mockResolvedValueOnce(stand(["finanzen"]));
    await cache.lesen();
    expect((await cache.lesen({ frisch: true })).bereiche).toEqual(["lohn"]);
    cache.leeren();
    expect((await cache.lesen()).bereiche).toEqual(["finanzen"]);
    expect(laden).toHaveBeenCalledTimes(3);
  });

  it("Fehler: letzter bekannter Stand bleibt", async () => {
    const { cache, laden, beiFehler, vor } = aufbau();
    laden.mockResolvedValueOnce(stand(["lohn"])).mockRejectedValueOnce(new Error("DB weg"));
    await cache.lesen();
    vor(20_000);
    expect((await cache.lesen()).bereiche).toEqual(["lohn"]);
    expect(beiFehler).toHaveBeenCalledTimes(1);
  });

  it("Fehler ohne bekannten Stand: keine Wartung, nicht gemerkt", async () => {
    const { cache, laden } = aufbau();
    laden.mockRejectedValueOnce(new Error("Tabelle fehlt")).mockResolvedValueOnce(stand(["geraete"]));
    expect(await cache.lesen()).toEqual(KEINE_WARTUNG);
    expect((await cache.lesen()).bereiche).toEqual(["geraete"]);
    expect(laden).toHaveBeenCalledTimes(2);
  });

  it("leeren während eines Ladens: veraltetes Ergebnis wird nicht gemerkt", async () => {
    const { cache, laden } = aufbau();
    let loese: (s: WartungStand) => void = () => {};
    laden.mockImplementationOnce(() => new Promise((r) => { loese = r; })).mockResolvedValueOnce(KEINE_WARTUNG);
    const alt = cache.lesen();
    cache.leeren();
    loese(stand(["lohn"]));
    expect((await alt).bereiche).toEqual(["lohn"]);
    expect((await cache.lesen()).bereiche).toEqual([]);
    expect(laden).toHaveBeenCalledTimes(2);
  });
});
