import { describe, it, expect, vi, beforeEach } from "vitest";

// Eingang-KI → Positionsgruppen + Einzelpositionen (Migration 352):
//   - eigene, unberuehrte KI-Eintraege werden bei der Wiederverarbeitung
//     ersetzt (nicht im Kontext); geschuetzte bleiben und stehen im Kontext
//   - von Hand erfasste/geaenderte Gruppen und Einzelpositionen aendert/
//     loescht die KI nie — sie protokolliert nur einen Vorschlag
//   - Einzelpositionen mit Rueckmeldung/Kommentar/Bestaetigung werden nie
//     geloescht, eine Gruppe mit solchen auch nicht
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
      const neu = (Array.isArray(werte) ? werte : [werte!]).map((w) => {
        const r: Row = { id: `neu-${++idZaehler}`, created_at: new Date().toISOString(), manuell_geaendert_at: null, inhalt_geaendert_at: null, ...w };
        // Trigger job_anforderungen_nummer: je Auftrag fortlaufend.
        if (tabelle === "job_anforderungen" && r.nummer == null) {
          r.nummer = Math.max(0, ...(db[tabelle] ?? []).filter((g) => g.job_id === r.job_id).map((g) => Number(g.nummer))) + 1;
        }
        return r;
      });
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
      // ON DELETE CASCADE: Einzelpositionen einer geloeschten Gruppe.
      if (tabelle === "job_anforderungen") {
        const weg = new Set(t.map((g) => g.id));
        db.job_technik_positionen = (db.job_technik_positionen ?? []).filter((p) => !weg.has(p.gruppe_id));
      }
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
const ANDERES = "item-0";
const grp = (id: string, nummer: number, extra: Row = {}): Row => ({
  id, job_id: JOB, nummer, titel: id, text: `Text ${id}`, quelle_item_id: ANDERES, created_via: "ki",
  manuell_geaendert_at: null, inhalt_geaendert_at: null, created_at: "2026-10-01T09:00:00Z", ...extra,
});
const pos = (id: string, gruppe: string, extra: Row = {}): Row => ({
  id, job_id: JOB, gruppe_id: gruppe, status: "geplant", menge: 1, bezeichnung: id, details: null,
  quelle_item_id: ANDERES, created_via: "ki", manuell_geaendert_at: null, inhalt_geaendert_at: null,
  created_at: "2026-10-01T10:00:00Z", ...extra,
});
const e = (aktion: string, position_id: string | null, menge: number, bezeichnung: string, kategorie = "Audio") =>
  ({ aktion, position_id, menge, bezeichnung, kategorie, details: null });
const g = (aktion: string, gruppe_id: string | null, titel: string, beschreibung: string, einzelpositionen: Row[] = []) =>
  ({ aktion, gruppe_id, titel, beschreibung, einzelpositionen });

function kiAntwort(positionsgruppen: Row[]) {
  return {
    zusammenfassung: "=== OPERATIV ===\n=== ADMINISTRATIV ===",
    datum_aenderung: null,
    inhalt_datum: null,
    termin_vorschlaege: [],
    positionsgruppen,
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
  db.job_anforderungen = [
    grp("G1-eigen", 1, { quelle_item_id: ITEM }),          // dieses Element, unberuehrt → ersetzbar
    grp("G2-ki", 2),                                        // anderes Element, KI
    grp("G3-manuell", 3, { created_via: "manuell" }),      // von Hand erfasst
    grp("G4-ki-frei", 4),                                   // KI, ohne geschuetzte Positionen
    grp("G5-ki-angepasst", 5, { manuell_geaendert_at: "2026-10-03T10:00:00Z" }), // KI, von Hand angepasst
  ];
  db.job_technik_positionen = [
    pos("P1-eigen", "G1-eigen", { quelle_item_id: ITEM }),
    pos("P2-review", "G2-ki", { quelle_item_id: ITEM }),     // eigenes Element, aber mit Rueckmeldung
    pos("P3-kommentar", "G3-manuell", { created_via: "manuell", quelle_item_id: null }),
    pos("P4-manuell", "G3-manuell", { created_via: "manuell", quelle_item_id: null }),
    pos("P5-bestaetigt-gleich", "G2-ki", { status: "bestaetigt", menge: 2, bestaetigt_at: "2026-10-02T10:00:00Z" }),
    pos("P6-bestaetigt-neu", "G2-ki", { status: "bestaetigt", menge: 2, bestaetigt_at: "2026-10-02T10:00:00Z" }),
    pos("P7-frei", "G4-ki-frei"),
  ];
  db.job_technik_reviews = [{ id: "r1", job_id: JOB, position_id: "P2-review" }];
  db.job_technik_kommentare = [{ id: "k1", job_id: JOB, position_id: "P3-kommentar" }];
  db.job_appointments = [];
  db.lieferant_katalog_artikel = [
    { lieferant_id: "l1", is_active: true, hauptkategorie: "Audio" },
    { lieferant_id: "l1", is_active: true, hauptkategorie: "Rigging" },
  ];
});

const lauf = () => verarbeiteEingangItem({ admin: admin as unknown as SupabaseClient, jobId: JOB, itemId: ITEM, actorUserId: null });
const posIds = () => (db.job_technik_positionen ?? []).map((p) => p.id);
const grpIds = () => (db.job_anforderungen ?? []).map((p) => p.id);
const finde = (id: string) => db.job_technik_positionen.find((p) => p.id === id)!;
const gruppe = (id: string) => db.job_anforderungen.find((p) => p.id === id)!;

describe("Eingang-KI: Positionsgruppen", () => {
  it("ersetzt eigene unberuehrte Eintraege, Kontext ohne diese; neue Gruppe mit nur genanntem Material", async () => {
    kiErgebnis = kiAntwort([
      g("neu", null, "Rahmen", "3 m hoch, 4 m breit, um ein Tuch darin zu spannen", [
        e("neu", null, 2.4, "Stativ", "Rigging"),
        e("neu", null, 0, "Null-Menge"),
        e("neu", null, 1, "Traverse 4 m", "Erfunden"),
      ]),
      g("neu", null, "Beschallung", "Ton bis hinten gut hörbar"),
    ]);
    await lauf();
    expect(grpIds()).not.toContain("G1-eigen");
    expect(posIds()).not.toContain("P1-eigen");
    expect(posIds()).toContain("P2-review"); // eigenes Element, aber geschuetzt
    expect(calls.kontext).not.toContain("G1-eigen");
    expect(calls.kontext).not.toContain("P1-eigen");
    expect(calls.kontext).toContain("P2-review");
    expect(calls.kontext).toContain("G3-manuell | Pos 03");
    const neueG = db.job_anforderungen.filter((x) => String(x.id).startsWith("neu-"));
    expect(neueG.map((x) => [x.titel, x.text, x.created_via, x.quelle_item_id, x.nummer])).toEqual([
      ["Rahmen", "3 m hoch, 4 m breit, um ein Tuch darin zu spannen", "ki", ITEM, 6],
      ["Beschallung", "Ton bis hinten gut hörbar", "ki", ITEM, 7],
    ]);
    const neueP = db.job_technik_positionen.filter((x) => String(x.id).startsWith("neu-"));
    expect(neueP.map((x) => [x.gruppe_id, x.bezeichnung, x.menge, x.kategorie, x.quelle, x.created_via])).toEqual([
      [neueG[0].id, "Stativ", 2, "Rigging", "kunde", "ki"],
      [neueG[0].id, "Traverse 4 m", 1, "Sonstiges", "kunde", "ki"],
    ]);
    // Beschallung ohne Material: keine erfundenen Einzelpositionen.
    expect(db.job_technik_positionen.some((x) => x.gruppe_id === neueG[1].id)).toBe(false);
    expect(calls.logs.some((l) => l.aktion === "ki_gruppen")).toBe(true);
    expect(calls.logs.some((l) => l.aktion === "ki_positionen")).toBe(true);
    expect(db.job_inbox_items[0].ai_status).toBe("verarbeitet");
  });

  it("Folgemail aendert eine KI-Gruppe in place; von Hand gepflegte nur als Vorschlag", async () => {
    kiErgebnis = kiAntwort([
      g("aendern", "G4-ki-frei", "Rahmen", "3 m hoch, 5 m breit"),
      g("aendern", "G3-manuell", "G3-manuell", "Neue Angabe vom Kunden"),
      g("aendern", "G5-ki-angepasst", "Licht", "anders"),
      g("aendern", "erfunden-id", "X", "Y"),
    ]);
    await lauf();
    expect(gruppe("G4-ki-frei")).toMatchObject({ titel: "Rahmen", text: "3 m hoch, 5 m breit" });
    expect(gruppe("G3-manuell").text).toBe("Text G3-manuell");
    expect(gruppe("G5-ki-angepasst").text).toBe("Text G5-ki-angepasst");
    expect(calls.logs.filter((l) => l.aktion === "ki_gruppe_geaendert")).toHaveLength(1);
    expect(calls.logs.filter((l) => l.aktion === "ki_gruppe_aendern_vorgeschlagen")).toHaveLength(2);
    expect(db.job_anforderungen).toHaveLength(5 - 1); // nur G1-eigen ersetzt, nichts neu
  });

  it("neue Einzelposition darf in eine von Hand gepflegte Gruppe; manuelle Einzelposition bleibt unveraendert", async () => {
    kiErgebnis = kiAntwort([
      g("unveraendert", "G3-manuell", "G3-manuell", "Text G3-manuell", [
        e("neu", null, 2, "Funkmikrofon"),
        e("aendern", "P4-manuell", 5, "P4-manuell"),
      ]),
    ]);
    await lauf();
    expect(db.job_technik_positionen.some((x) => x.gruppe_id === "G3-manuell" && x.bezeichnung === "Funkmikrofon")).toBe(true);
    expect(finde("P4-manuell").menge).toBe(1);
    expect(calls.logs.filter((l) => l.aktion === "ki_aendern_vorgeschlagen")).toHaveLength(1);
  });

  it("«entfernen»: Gruppe mit geschuetzter Position nur protokolliert, freie Gruppe samt Positionen geloescht", async () => {
    kiErgebnis = kiAntwort([
      g("entfernen", "G2-ki", "G2-ki", ""),
      g("entfernen", "G4-ki-frei", "G4-ki-frei", ""),
      g("entfernen", "G3-manuell", "G3-manuell", ""),
    ]);
    await lauf();
    expect(grpIds()).toContain("G2-ki");
    expect(grpIds()).toContain("G3-manuell");
    expect(grpIds()).not.toContain("G4-ki-frei");
    expect(posIds()).not.toContain("P7-frei");
    expect(calls.logs.filter((l) => l.aktion === "ki_entfernen_vorgeschlagen")).toHaveLength(2);
    expect(calls.logs.filter((l) => l.aktion === "ki_gruppe_entfernt")).toHaveLength(1);
    expect(calls.logs.filter((l) => l.aktion === "ki_entfernt")).toHaveLength(1); // P7 einzeln protokolliert
  });

  it("Einzelposition «entfernen»: geschuetzt/manuell nur protokolliert, frei geloescht", async () => {
    kiErgebnis = kiAntwort([
      g("unveraendert", "G2-ki", "G2-ki", "Text G2-ki", [e("entfernen", "P2-review", 1, "x")]),
      g("unveraendert", "G3-manuell", "G3-manuell", "Text G3-manuell", [e("entfernen", "P3-kommentar", 1, "x")]),
      g("unveraendert", "G4-ki-frei", "G4-ki-frei", "Text G4-ki-frei", [e("entfernen", "P7-frei", 1, "x")]),
    ]);
    await lauf();
    expect(posIds()).toContain("P2-review");
    expect(posIds()).toContain("P3-kommentar");
    expect(posIds()).not.toContain("P7-frei");
    expect(calls.logs.filter((l) => l.aktion === "ki_entfernen_vorgeschlagen")).toHaveLength(2);
    expect(calls.logs.filter((l) => l.aktion === "ki_entfernt")).toHaveLength(1);
  });

  it("«aendern» ohne echte Aenderung laesst die Bestaetigung stehen; mit Aenderung ganzzahlig + zurueckgesetzt", async () => {
    kiErgebnis = kiAntwort([
      g("unveraendert", "G2-ki", "G2-ki", "Text G2-ki", [
        e("aendern", "P5-bestaetigt-gleich", 2, "P5-bestaetigt-gleich"),
        e("aendern", "P6-bestaetigt-neu", 3.7, "P6-bestaetigt-neu"),
      ]),
    ]);
    await lauf();
    expect(finde("P5-bestaetigt-gleich").status).toBe("bestaetigt");
    expect(finde("P6-bestaetigt-neu")).toMatchObject({ menge: 4, status: "geplant", bestaetigt_at: null });
    expect(calls.logs.filter((l) => l.aktion === "ki_geaendert")).toHaveLength(1);
    expect(gruppe("G2-ki").text).toBe("Text G2-ki"); // «unveraendert» fasst die Gruppe nicht an
  });

  // Archiv = nur lesen (src/lib/archiv.ts): Mail an einen abgeschlossenen/
  // stornierten Auftrag bleibt im Verlauf, aber die KI aendert nichts mehr.
  for (const status of ["abgeschlossen", "storniert"]) {
    it(`archivierter Auftrag (${status}): keine KI, nichts geaendert, Element erledigt`, async () => {
      db.jobs[0].status = status;
      const vorher = JSON.stringify([db.job_technik_positionen, db.job_anforderungen]);
      kiErgebnis = kiAntwort([g("neu", null, "Funk", "", [e("neu", null, 2, "Funkmikrofon")])]);
      const r = await lauf();
      expect(r).toEqual({ datumVorschlag: null, terminVorschlaege: 0 });
      expect(calls.kontext).toBe("");
      expect(JSON.stringify([db.job_technik_positionen, db.job_anforderungen])).toBe(vorher);
      expect(db.jobs[0].ai_summary).toBeNull();
      expect(db.job_inbox_items[0].ai_status).toBe("verarbeitet");
    });
  }

  it("Schreibfehler: Element «fehler», keine «erfasst»-Meldung", async () => {
    kiErgebnis = kiAntwort([g("unveraendert", "G4-ki-frei", "G4-ki-frei", "Text G4-ki-frei", [e("neu", null, 2, "Funkmikrofon")])]);
    fehlerBeim.tabelle = "job_technik_positionen";
    fehlerBeim.op = "insert";
    await expect(lauf()).rejects.toThrow(/fehlgeschlagen/);
    expect(db.job_inbox_items[0].ai_status).toBe("fehler");
    expect(calls.logs.some((l) => l.aktion === "ki_positionen")).toBe(false);
  });
});
