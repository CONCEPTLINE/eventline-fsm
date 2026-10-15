import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeNichtVerfuegbarError } from "@/lib/ai/anthropic";
import { fakeAdmin, type FakeDb } from "./test-fake-db";

// Warteschlange «Rueckstau ZZ mit Claude» (Migration 329) — Claude ist immer
// gemockt (nie der App-Schluessel), zz-entscheid ebenso (eigene Tests dort).

const PFAD = "ZZ_Dokumente/_EVENTLINE/20260828191911_001.pdf";
const ORDNER_IST = "ZZ_Dokumente/_EVENTLINE";
const ZIEL = "01_FIRMA/03_Rechnungen";

vi.mock("./kontext", async (orig) => ({
  ...(await orig<typeof import("./kontext")>()),
  ladeAktiveOrdner: vi.fn(async () => new Set([ZIEL, "01_FIRMA", "01_FIRMA/04_Offerten", "06_PERSONAL/1001_Muster", "06_PERSONAL/1001_Muster/Vertraege"])),
  ladeIndexZeilen: vi.fn(async (_a: unknown, pfade: string[]) =>
    new Map(pfade.filter((p) => p === PFAD).map((p) => [p, { pfad: p, name: "20260828191911_001.pdf", ordner_pfad: ORDNER_IST, geaendert: null }])),
  ),
}));

const validiere = vi.fn();
vi.mock("./zz-entscheid", () => ({
  baueZzEingabe: vi.fn(() => "EINGABE"),
  frageClaudeZz: vi.fn(),
  herkunftAusPfad: vi.fn(() => ["_EVENTLINE"]),
  waehleBeispiele: vi.fn(() => []),
  validiereZzEntscheid: (roh: unknown, opts: unknown) => validiere(roh, opts),
}));

const { verarbeiteZzWarteschlange, ordnerFuerNamen } = await import("./zz-warteschlange");

function db(p: Partial<FakeDb["tabellen"]> = {}): FakeDb {
  return {
    tabellen: {
      nas_zz_beschriebe: [
        {
          id: "b1", pfad: PFAD, sha256: null, ordner_ist: ORDNER_IST, rezept: "zz/v3", beschrieb: { dokart: "rechnung" }, fakten: [], kandidaten: [ZIEL],
          status: "wartet", versuche: 0, lauf_id: "l1", created_at: "2026-10-15T01:00:00Z", updated_at: "2026-10-15T01:00:00Z",
        },
      ],
      nas_vorschlaege: [],
      nas_ablage_lernbeispiele: [],
      ablage_datei_index: [],
      ...p,
    },
    unique: {
      nas_vorschlaege: (z, alle) => alle.some((a) => a.status === "offen" && a.art === z.art && a.pfad === z.pfad),
    },
    aufrufe: [],
  };
}

const ENTSCHEID = { ziel_ordner: ZIEL, ziel_neu: false, name_vorschlag: "2026-08-28_Scan_Rechnung_Herzog-Tech.pdf", begruendung: "Rechnung → Firmenrechnungen", sicherheit: "hoch", alternativen: ["01_FIRMA/04_Offerten", "ZZ_Dokumente"] };
const lauf = (d: FakeDb, frage: () => Promise<unknown>) =>
  verarbeiteZzWarteschlange(fakeAdmin(d) as never, { budgetMs: 200_000, max: 10 }, { frageClaude: frage });

beforeEach(() => {
  validiere.mockReset();
  validiere.mockImplementation((roh: unknown) => roh);
});

describe("verarbeiteZzWarteschlange", () => {
  it("legt einen offenen Claude-Vorschlag an und schliesst die Zeile ab (Beschrieb bleibt)", async () => {
    const d = db();
    const r = await lauf(d, async () => ENTSCHEID);
    expect(r).toMatchObject({ geholt: 1, fertig: 1, verworfen: 0, fehler: 0, claudeGesperrt: false });
    const v = d.tabellen.nas_vorschlaege[0];
    expect(v).toMatchObject({
      art: "zz", pfad: PFAD, quelle: "claude", ziel_ordner: ZIEL, ziel_neu: false, rezept: "zz/v3",
      name_vorschlag: "2026-08-28_Scan_Rechnung_Herzog-Tech.pdf", alternativen: ["01_FIRMA/04_Offerten"], sicherheit: "hoch",
    });
    const b = d.tabellen.nas_zz_beschriebe[0];
    expect(b).toMatchObject({ status: "fertig", vorschlag_id: v.id, beschrieb: { dokart: "rechnung" } });
  });

  it("exaktes Doppel (Migration 334): kein Claude-Aufruf, Vorschlag auf den Ordner der Kopie", async () => {
    const KOPIE = `${ZIEL}/20260828191911_001.pdf`;
    const ANDERS = "ZZ_Dokumente/_EVENTLINE/anders.pdf";
    const kontext = await import("./kontext");
    const index = vi.mocked(kontext.ladeIndexZeilen);
    const vorher = index.getMockImplementation();
    index.mockImplementation(async (_a: unknown, pfade: readonly string[]) =>
      new Map(pfade.filter((p) => p === PFAD || p === KOPIE || p === ANDERS).map((p) => [p, { pfad: p, name: p.slice(p.lastIndexOf("/") + 1), ordner_pfad: p === KOPIE ? ZIEL : ORDNER_IST, geaendert: null }])),
    );
    try {
      const doppelt = [{ gruppe: "g:x", art: "gleich", pfad: PFAD, kopie: 1 }, { gruppe: "g:x", art: "gleich", pfad: KOPIE, kopie: 1 }];
      const d = db({ nas_doppel: doppelt });
      const frage = vi.fn(async () => ENTSCHEID);
      const r = await lauf(d, frage);
      expect(frage).not.toHaveBeenCalled();
      expect(r).toMatchObject({ fertig: 1, doppelOhneClaude: 1 });
      expect(d.tabellen.nas_vorschlaege[0]).toMatchObject({ quelle: "regel", ziel_ordner: ZIEL, sicherheit: "hoch", name_vorschlag: null, modell: "doppel" });
      // Gleicher Inhalt in anderer Form (andere Kopie-Nummer) → wie bisher Claude.
      const d2 = db({ nas_doppel: [doppelt[0], { ...doppelt[1], kopie: 2 }] });
      const frage2 = vi.fn(async () => ENTSCHEID);
      expect(await lauf(d2, frage2)).toMatchObject({ fertig: 1, doppelOhneClaude: 0 });
      expect(frage2).toHaveBeenCalledTimes(1);
      // Tabelle fehlt / Fehler → leer, Claude wie bisher.
      const d3 = db();
      const frage3 = vi.fn(async () => ENTSCHEID);
      expect(await lauf(d3, frage3)).toMatchObject({ fertig: 1, doppelOhneClaude: 0 });
      // Claude gesperrt: die exakte Kopie kommt trotzdem dran (zuerst), die aeltere Claude-Zeile wartet weiter.
      const aelter = { ...db().tabellen.nas_zz_beschriebe[0], id: "b0", pfad: ANDERS, created_at: "2026-10-14T01:00:00Z" };
      const d4 = db({ nas_doppel: doppelt });
      d4.tabellen.nas_zz_beschriebe.unshift(aelter);
      const gesperrt = vi.fn(async () => { throw new ClaudeNichtVerfuegbarError("limit", 402); });
      const r4 = await lauf(d4, gesperrt);
      expect(r4).toMatchObject({ doppelOhneClaude: 1, fertig: 1 });
      expect(d4.tabellen.nas_vorschlaege.map((v) => v.pfad)).toEqual([PFAD]);
    } finally {
      index.mockImplementation(vorher!);
    }
  });

  it("ungueltiger Namensvorschlag -> null, Vorschlag trotzdem", async () => {
    const d = db();
    await lauf(d, async () => ({ ...ENTSCHEID, name_vorschlag: "Lohn_28_CHF.pdf" }));
    expect(d.tabellen.nas_vorschlaege[0].name_vorschlag).toBeNull();
  });

  it("ersetzt offenen Vorschlag mit aelterem/keinem Rezept: alt geloescht, neu eingefuegt", async () => {
    for (const rezept of ["zz/v2", null]) {
      const d = db({ nas_vorschlaege: [{ id: "alt", art: "zz", pfad: PFAD, status: "offen", rezept, ziel_ordner: "01_FIRMA", entschieden_von: null }] });
      const r = await lauf(d, async () => ENTSCHEID);
      expect(r).toMatchObject({ ersetzt_geloescht: 1, fertig: 1 });
      expect(d.tabellen.nas_vorschlaege.map((v) => v.id)).not.toContain("alt");
      expect(d.tabellen.nas_vorschlaege).toHaveLength(1);
      expect(d.tabellen.nas_vorschlaege[0]).toMatchObject({ quelle: "claude", rezept: "zz/v3" });
    }
  });

  it("offen mit gleichem Rezept -> verworfen (doppelt), alt bleibt", async () => {
    const d = db({ nas_vorschlaege: [{ id: "alt", art: "zz", pfad: PFAD, status: "offen", rezept: "zz/v3", ziel_ordner: "01_FIRMA" }] });
    const r = await lauf(d, async () => ENTSCHEID);
    expect(r).toMatchObject({ ersetzt_geloescht: 0, verworfen: 1 });
    expect(d.tabellen.nas_vorschlaege.map((v) => v.id)).toEqual(["alt"]);
  });

  it("alt inzwischen entschieden (entschieden_von gesetzt) -> nicht geloescht, neuer verworfen", async () => {
    const d = db({ nas_vorschlaege: [{ id: "alt", art: "zz", pfad: PFAD, status: "offen", rezept: "zz/v2", ziel_ordner: "01_FIRMA", entschieden_von: "u1" }] });
    const r = await lauf(d, async () => ENTSCHEID);
    expect(r).toMatchObject({ ersetzt_geloescht: 0, verworfen: 1, fertig: 0 });
    expect(d.tabellen.nas_vorschlaege.map((v) => v.id)).toEqual(["alt"]);
    expect(d.tabellen.nas_zz_beschriebe[0]).toMatchObject({ status: "verworfen", fehler: "entschieden" });
  });

  it("angenommen (Verschiebung steht aus) -> verworfen, nichts ersetzt", async () => {
    const d = db({ nas_vorschlaege: [{ id: "a", art: "zz", pfad: PFAD, status: "angenommen", rezept: null, ziel_ordner: ZIEL }] });
    const r = await lauf(d, async () => ENTSCHEID);
    expect(r).toMatchObject({ fertig: 0, verworfen: 1 });
    expect(d.tabellen.nas_zz_beschriebe[0]).toMatchObject({ status: "verworfen", fehler: "ausstehend" });
  });

  it("abgelehnt mit gleichem Ziel -> verworfen", async () => {
    const d = db({ nas_vorschlaege: [{ id: "x", art: "zz", pfad: PFAD, status: "abgelehnt", rezept: "zz/v2", ziel_ordner: ZIEL, entschieden_am: "2026-10-10T00:00:00Z" }] });
    await lauf(d, async () => ENTSCHEID);
    expect(d.tabellen.nas_zz_beschriebe[0]).toMatchObject({ status: "verworfen", fehler: "abgelehnt_bekannt" });
  });

  it("neuer Ordner unter aktivem Oberordner -> ziel_neu", async () => {
    const d = db();
    await lauf(d, async () => ({ ...ENTSCHEID, ziel_ordner: "01_FIRMA/05_Versicherungen", ziel_neu: true }));
    expect(d.tabellen.nas_vorschlaege[0]).toMatchObject({ ziel_ordner: "01_FIRMA/05_Versicherungen", ziel_neu: true });
  });

  it("neuer Ordner ohne aktiven Oberordner -> antwort_ungueltig, Versuch +1", async () => {
    const d = db();
    const r = await lauf(d, async () => ({ ...ENTSCHEID, ziel_ordner: "09_GIBTSNICHT/Neu", ziel_neu: true }));
    expect(r.zurueck).toBe(1);
    expect(d.tabellen.nas_zz_beschriebe[0]).toMatchObject({ status: "wartet", versuche: 1, fehler: "antwort_ungueltig" });
  });

  it("ungueltige Antwort beim dritten Versuch -> fehler", async () => {
    validiere.mockReturnValue(null);
    const d = db();
    d.tabellen.nas_zz_beschriebe[0].versuche = 2;
    const r = await lauf(d, async () => ({}));
    expect(r.fehler).toBe(1);
    expect(d.tabellen.nas_zz_beschriebe[0]).toMatchObject({ status: "fehler", versuche: 3 });
  });

  it("Claude gesperrt -> Zeile wartet ohne Versuch, Lauf endet", async () => {
    const d = db();
    d.tabellen.nas_zz_beschriebe.push({ ...d.tabellen.nas_zz_beschriebe[0], id: "b2", created_at: "2026-10-15T02:00:00Z" });
    const frage = vi.fn(async () => {
      throw new ClaudeNichtVerfuegbarError("limit", 402);
    });
    const r = await lauf(d, frage);
    expect(r).toMatchObject({ claudeGesperrt: true, geholt: 1, zurueck: 1 });
    expect(frage).toHaveBeenCalledTimes(1);
    expect(d.tabellen.nas_zz_beschriebe.map((b) => [b.status, b.versuche])).toEqual([["wartet", 0], ["wartet", 0]]);
  });

  it("Datei nicht mehr im Index -> verworfen ohne Claude", async () => {
    const d = db();
    d.tabellen.nas_zz_beschriebe[0].pfad = "ZZ_Dokumente/weg.pdf";
    const frage = vi.fn(async () => ENTSCHEID);
    await lauf(d, frage);
    expect(frage).not.toHaveBeenCalled();
    expect(d.tabellen.nas_zz_beschriebe[0]).toMatchObject({ status: "verworfen", fehler: "pfad_bewegt" });
  });

  it("schon geclaimte Zeile (anderer Lauf) wird nicht angefasst", async () => {
    const d = db();
    d.tabellen.nas_zz_beschriebe[0].status = "in_arbeit";
    d.tabellen.nas_zz_beschriebe[0].updated_at = new Date().toISOString();
    const frage = vi.fn(async () => ENTSCHEID);
    const r = await lauf(d, frage);
    expect(r.geholt).toBe(0);
    expect(frage).not.toHaveBeenCalled();
  });

  it("haengende Zeile (in_arbeit > 15 min) kommt zurueck und wird verarbeitet", async () => {
    const d = db();
    d.tabellen.nas_zz_beschriebe[0].status = "in_arbeit";
    d.tabellen.nas_zz_beschriebe[0].updated_at = "2026-01-01T00:00:00Z";
    const r = await lauf(d, async () => ENTSCHEID);
    expect(r).toMatchObject({ haengendZurueck: 1, fertig: 1 });
  });
});

describe("neue Ordner aus offenen Vorschlaegen", () => {
  it("gibt offene ziel_neu-Ordner mit und nimmt im Lauf neu vorgeschlagene dazu", async () => {
    const { baueZzEingabe } = await import("./zz-entscheid");
    const bau = vi.mocked(baueZzEingabe);
    bau.mockClear();
    const listen: string[][] = [];
    bau.mockImplementation((o) => {
      listen.push([...(o.neueOrdnerOffen ?? [])]);
      return "EINGABE";
    });
    const d = db({ nas_vorschlaege: [{ id: "n1", art: "zz", pfad: "ZZ_Dokumente/anders.pdf", status: "offen", ziel_neu: true, ziel_ordner: "06_PERSONAL/1002_Neu" }] });
    d.tabellen.nas_zz_beschriebe.push({ ...d.tabellen.nas_zz_beschriebe[0], id: "b2", created_at: "2026-10-15T02:00:00Z" });
    await lauf(d, async () => ({ ...ENTSCHEID, ziel_ordner: "01_FIRMA/05_Versicherungen", ziel_neu: true }));
    expect(listen[0]).toEqual(["06_PERSONAL/1002_Neu"]);
    expect(listen[1]).toEqual(["06_PERSONAL/1002_Neu", "01_FIRMA/05_Versicherungen"]);
  });
});

describe("ordnerFuerNamen", () => {
  it("Kandidaten, in Fakten genannte Ordner, Unterordner von Personalakten", () => {
    const aktiv = ["01_FIRMA/03_Rechnungen", "01_FIRMA/04_Offerten", "06_PERSONAL/1001_Muster", "06_PERSONAL/1001_Muster/Vertraege", "06_PERSONAL/1001_Muster/Vertraege/Alt"];
    expect(ordnerFuerNamen(["06_PERSONAL/1001_Muster"], ["frueher abgelegt unter 01_FIRMA/04_Offerten"], aktiv)).toEqual([
      "06_PERSONAL/1001_Muster",
      "01_FIRMA/04_Offerten",
      "06_PERSONAL/1001_Muster/Vertraege",
    ]);
  });
});
