import { describe, expect, it } from "vitest";
import { entscheideFrist, leseFristEntscheid, type FristEntscheid } from "./fristen-entscheid";

// Attrappe der Supabase-Abfragen, die entscheideFrist braucht (select/eq/
// maybeSingle, update/eq/select, insert) — mit dem Unique-Index von
// ablage_fristen (coalesce(ablage_item_id, pfad), art, datum) -> 23505.

type Zeile = Record<string, unknown> & { id: string };

class Attrappe {
  zeilen: Zeile[];
  /** Laeuft unmittelbar vor jedem Update (simuliert einen zweiten Admin). */
  vorUpdate: (() => void) | null = null;
  updates = 0;
  constructor(zeilen: Zeile[]) {
    this.zeilen = zeilen.map((z) => ({ ...z }));
  }
  from(tabelle: string) {
    if (tabelle !== "ablage_fristen") throw new Error("unerwartete Tabelle " + tabelle);
    return new Abfrage(this);
  }
  schluessel(z: Zeile) {
    return `${(z.ablage_item_id as string | null) ?? (z.pfad as string)}|${z.art}|${z.datum}`;
  }
  verletzt(kandidat: Zeile, ausser?: string) {
    return this.zeilen.some((z) => z.id !== ausser && this.schluessel(z) === this.schluessel(kandidat));
  }
}

class Abfrage {
  private op: "select" | "update" | "insert" = "select";
  private filter: [string, unknown][] = [];
  private patch: Record<string, unknown> = {};
  private neu: Zeile | null = null;
  private einzeln = false;
  constructor(private db: Attrappe) {}
  select() { return this; }
  eq(k: string, v: unknown) { this.filter.push([k, v]); return this; }
  maybeSingle() { this.einzeln = true; return this; }
  update(p: Record<string, unknown>) { this.op = "update"; this.patch = p; return this; }
  insert(z: Record<string, unknown>) { this.op = "insert"; this.neu = { id: `neu-${this.db.zeilen.length}`, erinnert: [], ...z } as Zeile; return this; }
  private passt(z: Zeile) { return this.filter.every(([k, v]) => z[k] === v); }
  private fuehreAus(): { data: unknown; error: { code: string; message: string } | null } {
    if (this.op === "insert") {
      if (this.db.verletzt(this.neu!)) return { data: null, error: { code: "23505", message: "duplicate" } };
      this.db.zeilen.push(this.neu!);
      return { data: null, error: null };
    }
    if (this.op === "update") {
      this.db.vorUpdate?.();
      this.db.vorUpdate = null;
      this.db.updates++;
      const treffer = this.db.zeilen.filter((z) => this.passt(z));
      for (const z of treffer) {
        if (this.db.verletzt({ ...z, ...this.patch }, z.id)) return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      for (const z of treffer) Object.assign(z, this.patch);
      return { data: treffer.map((z) => ({ id: z.id, status: z.status, datum: z.datum })), error: null };
    }
    const treffer = this.db.zeilen.filter((z) => this.passt(z)).map((z) => ({ ...z }));
    return { data: this.einzeln ? treffer[0] ?? null : treffer, error: null };
  }
  then<T>(ok: (r: { data: unknown; error: { code: string; message: string } | null }) => T) {
    return Promise.resolve(this.fuehreAus()).then(ok);
  }
}

const ID = "11111111-2222-3333-4444-555555555555";
const HEUTE = "2026-10-12";
const JETZT = "2026-10-12T08:00:00.000Z";
const USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function kiVorschlag(extra: Partial<Zeile> = {}): Zeile {
  return {
    id: ID,
    ablage_item_id: null,
    pfad: "00_ADMIN_RECHT/03_Dauervertraege/Leasing.pdf",
    sha256: "a".repeat(64),
    art: "kuendigung",
    datum: "2026-12-31",
    bezeichnung: "Kündigung · Leasing.pdf",
    grundlage: { beginn: "2024-01-01", ende: null, faellig: null, laufzeit_monate: 36, verlaengerung_monate: 12, kuendigungsfrist: { anzahl: 3, einheit: "monate" } },
    quelle: "ki",
    status: "vorschlag",
    sicherheit: "hoch",
    erinnert: [],
    ...extra,
  };
}

// Attrappe -> Typ des Admin-Clients (nur die benutzten Methoden existieren).
const alsAdmin = (a: Attrappe) => a as unknown as Parameters<typeof entscheideFrist>[0];
const e = (aktion: FristEntscheid["aktion"], datum: string | null = null): FristEntscheid => ({ id: ID, aktion, datum });

describe("leseFristEntscheid", () => {
  it("nimmt gueltige Entscheide an und normalisiert die ID", () => {
    expect(leseFristEntscheid({ id: ID.toUpperCase(), aktion: "verwerfen" }, HEUTE)).toEqual({ ok: true, entscheid: { id: ID, aktion: "verwerfen", datum: null } });
    expect(leseFristEntscheid({ id: ID, aktion: "bestaetigen", datum: "2027-01-15" }, HEUTE)).toEqual({ ok: true, entscheid: { id: ID, aktion: "bestaetigen", datum: "2027-01-15" } });
    expect(leseFristEntscheid({ id: ID, aktion: "erledigt", datum: "" }, HEUTE)).toMatchObject({ ok: true });
  });
  it("weist formal falsche Bodies ab", () => {
    expect(leseFristEntscheid(null, HEUTE)).toMatchObject({ ok: false });
    expect(leseFristEntscheid({ id: "x", aktion: "verwerfen" }, HEUTE)).toMatchObject({ ok: false, fehler: "Ungültige ID" });
    expect(leseFristEntscheid({ id: ID, aktion: "loeschen" }, HEUTE)).toMatchObject({ ok: false, fehler: "Ungültige Aktion" });
    expect(leseFristEntscheid({ id: ID, aktion: "verwerfen", datum: "2027-01-01" }, HEUTE)).toMatchObject({ ok: false, fehler: "Datum nur beim Bestätigen" });
  });
  it("prueft das Datum: echtes Kalenderdatum, nicht vergangen, hoechstens 10 Jahre", () => {
    expect(leseFristEntscheid({ id: ID, aktion: "bestaetigen", datum: "2027-02-30" }, HEUTE)).toMatchObject({ ok: false, fehler: "Ungültiges Datum" });
    expect(leseFristEntscheid({ id: ID, aktion: "bestaetigen", datum: "12.10.2027" }, HEUTE)).toMatchObject({ ok: false, fehler: "Ungültiges Datum" });
    expect(leseFristEntscheid({ id: ID, aktion: "bestaetigen", datum: "2026-10-11" }, HEUTE)).toMatchObject({ ok: false, fehler: "Datum liegt in der Vergangenheit" });
    expect(leseFristEntscheid({ id: ID, aktion: "bestaetigen", datum: HEUTE }, HEUTE)).toMatchObject({ ok: true });
    expect(leseFristEntscheid({ id: ID, aktion: "bestaetigen", datum: "2036-10-12" }, HEUTE)).toMatchObject({ ok: true });
    expect(leseFristEntscheid({ id: ID, aktion: "bestaetigen", datum: "2036-10-13" }, HEUTE)).toMatchObject({ ok: false });
  });
});

describe("entscheideFrist", () => {
  it("bestaetigen: Vorschlag -> aktiv, mit Entscheider", async () => {
    const db = new Attrappe([kiVorschlag()]);
    const r = await entscheideFrist(alsAdmin(db), e("bestaetigen"), USER, JETZT);
    expect(r).toEqual({ ok: true, code: 200, status: "aktiv", datum: "2026-12-31" });
    expect(db.zeilen[0]).toMatchObject({ status: "aktiv", entschieden_von: USER, entschieden_am: JETZT, datum: "2026-12-31" });
    expect(db.zeilen).toHaveLength(1);
  });

  it("bestaetigen mit neuem Datum: Zeile wandert, KI-Datum bleibt als verworfene Sperr-Zeile", async () => {
    const db = new Attrappe([kiVorschlag({ erinnert: [30] })]);
    const r = await entscheideFrist(alsAdmin(db), e("bestaetigen", "2026-11-30"), USER, JETZT);
    expect(r).toMatchObject({ ok: true, status: "aktiv", datum: "2026-11-30" });
    expect(db.zeilen[0]).toMatchObject({ status: "aktiv", datum: "2026-11-30", erinnert: [] });
    expect(db.zeilen).toHaveLength(2);
    expect(db.zeilen[1]).toMatchObject({ status: "verworfen", quelle: "ki", datum: "2026-12-31", pfad: kiVorschlag().pfad, sha256: "a".repeat(64), art: "kuendigung" });
  });

  it("bestaetigen mit Datum einer schon vorhandenen Frist derselben Datei -> 409, nichts geaendert", async () => {
    const andere = kiVorschlag({ id: "99999999-2222-3333-4444-555555555555", datum: "2026-11-30", status: "aktiv", quelle: "ablage" });
    const db = new Attrappe([kiVorschlag(), andere]);
    const r = await entscheideFrist(alsAdmin(db), e("bestaetigen", "2026-11-30"), USER, JETZT);
    expect(r).toMatchObject({ ok: false, code: 409, status: "vorschlag" });
    expect(db.zeilen[0]).toMatchObject({ status: "vorschlag", datum: "2026-12-31" });
    expect(db.zeilen).toHaveLength(2);
  });

  it("verwerfen: Vorschlag -> verworfen, Zeile bleibt (Sperre gegen Wiedervorschlag)", async () => {
    const db = new Attrappe([kiVorschlag()]);
    expect(await entscheideFrist(alsAdmin(db), e("verwerfen"), USER, JETZT)).toMatchObject({ ok: true, status: "verworfen" });
    expect(db.zeilen).toHaveLength(1);
    expect(db.zeilen[0].status).toBe("verworfen");
  });

  it("verworfen kommt nie zurueck: bestaetigen/erledigt auf verworfen -> 409 ohne Update", async () => {
    const db = new Attrappe([kiVorschlag({ status: "verworfen" })]);
    expect(await entscheideFrist(alsAdmin(db), e("bestaetigen"), USER, JETZT)).toMatchObject({ ok: false, code: 409, status: "verworfen" });
    expect(await entscheideFrist(alsAdmin(db), e("erledigt"), USER, JETZT)).toMatchObject({ ok: false, code: 409 });
    expect(db.updates).toBe(0);
    expect(db.zeilen[0].status).toBe("verworfen");
  });

  it("idempotent: derselbe Entscheid zweimal = ok, ohne zweites Update", async () => {
    const db = new Attrappe([kiVorschlag()]);
    await entscheideFrist(alsAdmin(db), e("verwerfen"), USER, JETZT);
    expect(await entscheideFrist(alsAdmin(db), e("verwerfen"), USER, JETZT)).toMatchObject({ ok: true, code: 200, status: "verworfen" });
    expect(db.updates).toBe(1);

    const db2 = new Attrappe([kiVorschlag()]);
    await entscheideFrist(alsAdmin(db2), e("bestaetigen", "2026-11-30"), USER, JETZT);
    expect(await entscheideFrist(alsAdmin(db2), e("bestaetigen", "2026-11-30"), USER, JETZT)).toMatchObject({ ok: true, datum: "2026-11-30" });
    // anderes Datum nach dem Bestaetigen -> 409 (schon entschieden)
    expect(await entscheideFrist(alsAdmin(db2), e("bestaetigen", "2026-12-15"), USER, JETZT)).toMatchObject({ ok: false, code: 409 });
    expect(db2.zeilen).toHaveLength(2);
  });

  it("Rennen: ein zweiter Admin verwirft zwischen Lesen und Update -> 409 mit End-Status", async () => {
    const db = new Attrappe([kiVorschlag()]);
    db.vorUpdate = () => { db.zeilen[0].status = "verworfen"; };
    const r = await entscheideFrist(alsAdmin(db), e("bestaetigen", "2026-11-30"), USER, JETZT);
    expect(r).toMatchObject({ ok: false, code: 409, status: "verworfen" });
    expect(db.zeilen).toHaveLength(1); // keine Sperr-Zeile, Datum unveraendert
    expect(db.zeilen[0].datum).toBe("2026-12-31");
  });

  it("Rennen mit demselben Entscheid -> ok", async () => {
    const db = new Attrappe([kiVorschlag()]);
    db.vorUpdate = () => { db.zeilen[0].status = "verworfen"; };
    expect(await entscheideFrist(alsAdmin(db), e("verwerfen"), USER, JETZT)).toMatchObject({ ok: true, status: "verworfen" });
  });

  it("erledigt: nur aktive Fristen; Vorschlag -> 409 «noch nicht bestätigt»", async () => {
    const db = new Attrappe([kiVorschlag()]);
    expect(await entscheideFrist(alsAdmin(db), e("erledigt"), USER, JETZT)).toMatchObject({ ok: false, code: 409, fehler: "Frist ist noch nicht bestätigt" });
    const db2 = new Attrappe([kiVorschlag({ status: "aktiv", quelle: "ablage" })]);
    expect(await entscheideFrist(alsAdmin(db2), e("erledigt"), USER, JETZT)).toMatchObject({ ok: true, status: "erledigt" });
  });

  it("Ablage-Frist mit neuem Datum: keine Sperr-Zeile (nur KI-Fristen)", async () => {
    const db = new Attrappe([kiVorschlag({ quelle: "manuell" })]);
    await entscheideFrist(alsAdmin(db), e("bestaetigen", "2026-11-30"), USER, JETZT);
    expect(db.zeilen).toHaveLength(1);
  });

  it("unbekannte ID -> 404", async () => {
    const db = new Attrappe([]);
    expect(await entscheideFrist(alsAdmin(db), e("verwerfen"), USER, JETZT)).toMatchObject({ ok: false, code: 404 });
  });
});
