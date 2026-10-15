import { describe, it, expect, vi, beforeEach } from "vitest";

// Eingang-KI → Technik-Positionen (Wiederverarbeitung, 2026-10-15):
//   - eigene, UNgeschuetzte KI-Positionen werden ersetzt (nicht im Kontext)
//   - geschuetzte (Rueckmeldung/Kommentar/bestaetigt/platziert) bleiben und
//     stehen als «bestehend» im Kontext
//   - «entfernen» auf geschuetzte Positionen wird nur protokolliert
//   - «aendern» ohne echte Aenderung laesst die Bestaetigung stehen
//   - Mengen ganzzahlig (gerundet, mindestens 1), Kategorie aus dem Katalog
//   - Schreibfehler: Element «fehler», nichts als «erfasst» gemeldet
// Attrappen statt Netz/KI: In-Memory-Admin-Client + structuredCall.

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
const calls = { kontext: "", logs: [] as { aktion: string; beschreibung: string }[] };
const fehlerBeim: { tabelle: string | null; op: string | null } = { tabelle: null, op: null };
let kiErgebnis: unknown = null;
let idZaehler = 0;

function abfrage(tabelle: string) {
  const filter: ((r: Row) => boolean)[] = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let werte: Row | Row[] | null = null;
  const treffer = () => (db[tabelle] ?? []).filter((r) => filter.every((f) => f(r)));
  const ausfuehren = () => {
    if (fehlerBeim.tabelle === tabelle && fehlerBeim.op === op) return { data: null, error: { message: `${op} kaputt` } };
    if (op === "insert") {
      const neu = (Array.isArray(werte) ? werte : [werte!]).map((w) => ({ id: `neu-${++idZaehler}`, created_at: new Date().toISOString(), ...w }));
      db[tabelle] = [...(db[tabelle] ?? []), ...neu];
      return { data: neu, error: null };
    }
    if (op === "update") {
      const t = treffer();
      for (const r of t) Object.assign(r, werte);
      return { data: t, error: null };
    }
    if (op === "delete") {
      const t = treffer();
      db[tabelle] = (db[tabelle] ?? []).filter((r) => !t.includes(r));
      return { data: t, error: null };
    }
    return { data: treffer(), error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    order: () => b,
    limit: () => b,
    eq: (k: string, v: unknown) => (filter.push((r) => r[k] === v), b),
    neq: (k: string, v: unknown) => (filter.push((r) => r[k] !== v), b),
    in: (k: string, vs: unknown[]) => (filter.push((r) => vs.includes(r[k])), b),
    insert: (w: Row | Row[]) => ((op = "insert"), (werte = w), b),
    update: (w: Row) => ((op = "update"), (werte = w), b),
    delete: () => ((op = "delete"), b),
    maybeSingle: () => { const r = ausfuehren(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }); },
    single: () => { const r = ausfuehren(); return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error }); },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(ausfuehren()).then(res, rej),
  };
  return b;
}

const admin = {
  from: (t: string) => abfrage(t),
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://x" }, error: null }) }) },
};

vi.mock("@/lib/ai/anthropic", () => ({
  structuredCall: vi.fn(async (opts: { content: { type: string; text?: string }[] }) => {
    calls.kontext = opts.content.map((c) => c.text ?? "").join("\n");
    return kiErgebnis;
  }),
}));
vi.mock("@/lib/technik-server", () => ({
  logTechnik: vi.fn(async (_a: unknown, _j: unknown, _actor: unknown, aktion: string, beschreibung: string) => {
    calls.logs.push({ aktion, beschreibung });
  }),
  festerTechnikLieferant: vi.fn(async () => ({ ok: true, lieferant: { id: "l1", name: "Herzog Tech" } })),
}));

import { verarbeiteEingangItem } from "@/lib/ai/eingang-verarbeitung";
import type { SupabaseClient } from "@supabase/supabase-js";

const JOB = "job-1";
const ITEM = "item-1";
const pos = (id: string, extra: Row = {}): Row => ({
  id, job_id: JOB, status: "geplant", menge: 1, bezeichnung: id, details: null, masse: null, position: null,
  quelle_item_id: null, created_via: "manuell", created_at: "2026-10-01T10:00:00Z", ...extra,
});

function kiAntwort(material: Row[]) {
  return {
    zusammenfassung: "=== OPERATIV ===\n=== ADMINISTRATIV ===",
    datum_aenderung: null,
    inhalt_datum: null,
    termin_vorschlaege: [],
    material_positionen: material,
    kundenwuensche: [],
  };
}

beforeEach(() => {
  idZaehler = 0;
  calls.kontext = "";
  calls.logs = [];
  fehlerBeim.tabelle = null;
  fehlerBeim.op = null;
  for (const k of Object.keys(db)) delete db[k];
  db.jobs = [{ id: JOB, title: "Gala", job_number: 1, start_date: null, end_date: null, description: null, ai_summary: null, customer: null, location: null }];
  db.job_inbox_items = [{ id: ITEM, job_id: JOB, kind: "text", content: "Neue Mail", absender: null, ai_status: "neu" }];
  db.job_technik_positionen = [
    pos("P1-ki-frei", { quelle_item_id: ITEM, created_via: "ki" }),
    pos("P2-ki-review", { quelle_item_id: ITEM, created_via: "ki" }),
    pos("P3-kommentar"),
    pos("P4-frei"),
    pos("P5-bestaetigt-gleich", { status: "bestaetigt", menge: 2, bestaetigt_at: "2026-10-02T10:00:00Z" }),
    pos("P6-bestaetigt-neu", { status: "bestaetigt", menge: 2, bestaetigt_at: "2026-10-02T10:00:00Z" }),
    pos("P7-ki-platziert", { quelle_item_id: ITEM, created_via: "ki", position: [{ x: 1, y: 2, rot: 0 }] }),
  ];
  db.job_technik_reviews = [{ id: "r1", job_id: JOB, position_id: "P2-ki-review" }];
  db.job_technik_kommentare = [{ id: "k1", job_id: JOB, position_id: "P3-kommentar" }];
  db.job_anforderungen = [];
  db.job_appointments = [];
  db.lieferant_katalog_artikel = [
    { lieferant_id: "l1", is_active: true, hauptkategorie: "Audio" },
    { lieferant_id: "l1", is_active: true, hauptkategorie: "Mobiliar & Zelte" },
  ];
});

const lauf = () => verarbeiteEingangItem({ admin: admin as unknown as SupabaseClient, jobId: JOB, itemId: ITEM, actorUserId: null });
const ids = () => (db.job_technik_positionen ?? []).map((p) => p.id);
const finde = (id: string) => db.job_technik_positionen.find((p) => p.id === id)!;

describe("Eingang-KI: Wiederverarbeitung schuetzt Rueckmeldungen", () => {
  it("ersetzt nur ungeschuetzte eigene KI-Positionen, Kontext ohne diese", async () => {
    kiErgebnis = kiAntwort([
      { aktion: "neu", material_id: null, menge: 2.6, bezeichnung: "Stehtisch", kategorie: "Mobiliar & Zelte", details: null, masse: null },
      { aktion: "neu", material_id: null, menge: 0, bezeichnung: "Null-Menge", kategorie: "Audio", details: null, masse: null },
      { aktion: "neu", material_id: null, menge: 1, bezeichnung: "Unbekannte Kategorie", kategorie: "Erfunden", details: null, masse: null },
    ]);
    await lauf();
    expect(ids()).not.toContain("P1-ki-frei");
    expect(ids()).toContain("P2-ki-review");
    expect(ids()).toContain("P7-ki-platziert");
    expect(calls.kontext).not.toContain("P1-ki-frei");
    expect(calls.kontext).toContain("P2-ki-review");
    expect(calls.kontext).toContain("P7-ki-platziert");
    const neu = db.job_technik_positionen.filter((p) => String(p.id).startsWith("neu-"));
    expect(neu.map((p) => [p.bezeichnung, p.menge, p.kategorie, p.quelle, p.created_via])).toEqual([
      ["Stehtisch", 3, "Mobiliar & Zelte", "kunde", "ki"],
      ["Unbekannte Kategorie", 1, "Sonstiges", "kunde", "ki"],
    ]);
    expect(calls.logs.some((l) => l.aktion === "ki_positionen")).toBe(true);
    expect(db.job_inbox_items[0].ai_status).toBe("verarbeitet");
  });

  it("«entfernen»: geschuetzt nur protokolliert, ungeschuetzt geloescht", async () => {
    kiErgebnis = kiAntwort([
      { aktion: "entfernen", material_id: "P3-kommentar", menge: 1, bezeichnung: "x", kategorie: "Audio", details: null, masse: null },
      { aktion: "entfernen", material_id: "P2-ki-review", menge: 1, bezeichnung: "x", kategorie: "Audio", details: null, masse: null },
      { aktion: "entfernen", material_id: "P4-frei", menge: 1, bezeichnung: "x", kategorie: "Audio", details: null, masse: null },
    ]);
    await lauf();
    expect(ids()).toContain("P3-kommentar");
    expect(ids()).toContain("P2-ki-review");
    expect(ids()).not.toContain("P4-frei");
    expect(calls.logs.filter((l) => l.aktion === "ki_entfernen_vorgeschlagen")).toHaveLength(2);
    expect(calls.logs.filter((l) => l.aktion === "ki_entfernt")).toHaveLength(1);
  });

  it("«aendern» ohne echte Aenderung laesst die Bestaetigung stehen; mit Aenderung ganzzahlig + zurueckgesetzt", async () => {
    kiErgebnis = kiAntwort([
      { aktion: "aendern", material_id: "P5-bestaetigt-gleich", menge: 2, bezeichnung: "P5-bestaetigt-gleich", kategorie: "Audio", details: null, masse: null },
      { aktion: "aendern", material_id: "P6-bestaetigt-neu", menge: 3.7, bezeichnung: "P6-bestaetigt-neu", kategorie: "Audio", details: null, masse: null },
    ]);
    await lauf();
    expect(finde("P5-bestaetigt-gleich").status).toBe("bestaetigt");
    expect(finde("P6-bestaetigt-neu")).toMatchObject({ menge: 4, status: "geplant", bestaetigt_at: null });
    expect(calls.logs.filter((l) => l.aktion === "ki_geaendert")).toHaveLength(1);
  });

  // Archiv = nur lesen (src/lib/archiv.ts): Mail an einen abgeschlossenen/
  // stornierten Auftrag bleibt im Verlauf, aber die KI aendert nichts mehr.
  for (const status of ["abgeschlossen", "storniert"]) {
    it(`archivierter Auftrag (${status}): keine KI, nichts geaendert, Element erledigt`, async () => {
      db.jobs[0].status = status;
      const vorher = JSON.stringify(db.job_technik_positionen);
      kiErgebnis = kiAntwort([
        { aktion: "neu", material_id: null, menge: 2, bezeichnung: "Funkmikrofon", kategorie: "Audio", details: null, masse: null },
      ]);
      const r = await lauf();
      expect(r).toEqual({ datumVorschlag: null, terminVorschlaege: 0 });
      expect(calls.kontext).toBe("");
      expect(JSON.stringify(db.job_technik_positionen)).toBe(vorher);
      expect(db.jobs[0].ai_summary).toBeNull();
      expect(db.job_inbox_items[0].ai_status).toBe("verarbeitet");
    });
  }

  it("Schreibfehler: Element «fehler», keine «erfasst»-Meldung", async () => {
    kiErgebnis = kiAntwort([
      { aktion: "neu", material_id: null, menge: 2, bezeichnung: "Funkmikrofon", kategorie: "Audio", details: null, masse: null },
    ]);
    fehlerBeim.tabelle = "job_technik_positionen";
    fehlerBeim.op = "insert";
    await expect(lauf()).rejects.toThrow(/fehlgeschlagen/);
    expect(db.job_inbox_items[0].ai_status).toBe("fehler");
    expect(calls.logs.some((l) => l.aktion === "ki_positionen")).toBe(false);
  });
});
