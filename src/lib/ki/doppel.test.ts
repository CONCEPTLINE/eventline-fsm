// Doppel-Pruefung (Migration 330): reine Regeln (lib/ki/doppel) und die Route POST /api/ablage/doppel mit
// Attrappen — Quarantaene statt Loeschen, nie die letzte Kopie, idempotent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdmin, type FakeDb } from "./test-fake-db";
import {
  DOPPEL_QUARANTAENE,
  behaltenPaar,
  hinweisFuer,
  historieFuer,
  leseAblageDoppel,
  leseDoppelMeldung,
  liegtInHistorie,
  quarantaeneOrdner,
  type DoppelGruppe,
  type DoppelMitglied,
} from "./doppel";

const db = vi.hoisted(() => ({ aktuell: null as null | FakeDb }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/api-auth", () => ({ requireAdmin: async () => ({ user: { id: "admin-1" }, error: null }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin(db.aktuell!) }));

import { POST } from "@/app/api/ablage/doppel/route";

function mitglied(pfad: string, extra: Partial<DoppelMitglied> = {}): DoppelMitglied {
  return {
    pfad,
    name: pfad.slice(pfad.lastIndexOf("/") + 1),
    ordner: pfad.slice(0, pfad.lastIndexOf("/")),
    groesse: 100,
    geaendert: null,
    kopie: 1,
    rolle: null,
    aehnlichkeit: 1,
    zz: /(^|\/)ZZ_/i.test(pfad),
    ...extra,
  };
}

describe("leseDoppelMeldung", () => {
  const ok = (gruppen: unknown[], extra: Record<string, unknown> = {}) => leseDoppelMeldung({ lauf_id: "20261015T170000", gruppen, ...extra });

  it("nimmt gültige Gruppen und lässt ungültige Mitglieder/Gruppen weg", () => {
    const r = ok([
      { gruppe: "g:0123456789abcdef0123", art: "gleich", mitglieder: [
        { pfad: "02_LOC/Plan.pdf", groesse: 10, mtime: 1760000000, kopie: 1, aehnlichkeit: 1 },
        { pfad: "ZZ_Dok/Plan.pdf", groesse: 10, mtime: 1760000000, kopie: 1, aehnlichkeit: 1 },
        { pfad: "../etc/passwd", kopie: 1 },
        { pfad: "99_System/Papierkorb/x.pdf", kopie: 1 },
      ] },
      { gruppe: "g:0123456789abcdef0124", art: "gleich", mitglieder: [{ pfad: "A/allein.pdf", kopie: 1 }] },
      { gruppe: "kaputt", art: "gleich", mitglieder: [{ pfad: "A/a.pdf" }, { pfad: "A/b.pdf" }] },
      { gruppe: "f:0123456789abcdef0125", art: "fassung", mitglieder: [{ pfad: "A/V02.docx", rolle: "neu" }, { pfad: "A/V01.docx" }] },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meldung.gruppen).toHaveLength(1);
    expect(r.meldung.gruppen[0].mitglieder.map((m) => m.pfad)).toEqual(["02_LOC/Plan.pdf", "ZZ_Dok/Plan.pdf"]);
    expect(r.meldung.gruppen[0].mitglieder[0].geaendert).toBe(new Date(1760000000 * 1000).toISOString());
    expect(r.meldung.letzter).toBe(false);
  });

  it("verlangt lauf_id und begrenzt die Paketgrösse", () => {
    expect(leseDoppelMeldung({ gruppen: [] }).ok).toBe(false);
    expect(leseDoppelMeldung({ lauf_id: "x", gruppen: [] }).ok).toBe(false);
    expect(ok(new Array(301).fill({})).ok).toBe(false);
    const leer = ok([], { letzter: true });
    expect(leer.ok && leer.meldung.letzter).toBe(true);
  });

  it("Fassung braucht genau neu + alt", () => {
    const r = ok([{ gruppe: "f:0123456789abcdef0126", art: "fassung", mitglieder: [
      { pfad: "A/V02.docx", rolle: "neu", aehnlichkeit: 0.9 }, { pfad: "A/Historie/V01.docx", rolle: "alt", aehnlichkeit: 0.9 },
    ] }]);
    expect(r.ok && r.meldung.gruppen[0].mitglieder.map((m) => m.rolle)).toEqual(["neu", "alt"]);
  });
});

describe("Regeln", () => {
  it("leseAblageDoppel", () => {
    expect(leseAblageDoppel({ art: "exakt", pfad: "02_LOC/Plan.pdf", aehnlichkeit: 1 })).toEqual({ art: "exakt", pfad: "02_LOC/Plan.pdf", aehnlichkeit: 1 });
    expect(leseAblageDoppel({ art: "kopie", pfad: "02_LOC/Plan.pdf" })).toBeNull();
    expect(leseAblageDoppel({ art: "inhalt", pfad: "/abs/x.pdf" })).toBeNull();
  });

  it("Quarantäne-Ordner mit Datum in Zürich und Herkunft", () => {
    expect(quarantaeneOrdner("ZZ_Dok/_EVENTLINE", new Date("2026-10-15T21:30:00Z"))).toBe(`${DOPPEL_QUARANTAENE}/2026-10-15/ZZ_Dok/_EVENTLINE`);
    expect(quarantaeneOrdner("ZZ_Dok", new Date("2026-10-15T22:30:00Z"))).toBe(`${DOPPEL_QUARANTAENE}/2026-10-16/ZZ_Dok`);
  });

  it("Historie nach Hausbenennung, nie ZZ_", () => {
    const o = "02_LOC/SCALA/01_Entwuerfe";
    expect(historieFuer(o, [`${o}/Historie`, `${o}/Historie/alt`])).toEqual({ pfad: `${o}/Historie`, neu: false });
    expect(historieFuer(o, [`${o}/01_Aktuell`, `${o}/02_Historie`])).toEqual({ pfad: `${o}/02_Historie`, neu: false });
    expect(historieFuer(o, [`${o}/01_Aktuell`, `${o}/03_Vorlagen`])).toEqual({ pfad: `${o}/04_Historie`, neu: true });
    expect(historieFuer(o, [`${o}/Fotos`])).toEqual({ pfad: `${o}/Historie`, neu: true });
    expect(historieFuer(o, [`${o}/ZZ_Historie`])).toEqual({ pfad: `${o}/Historie`, neu: true });
    expect(historieFuer(o, ["02_LOC/SCALA/01_EntwuerfeX/Historie"])).toEqual({ pfad: `${o}/Historie`, neu: true });
    expect(liegtInHistorie(`${o}/Historie/V01.docx`)).toBe(true);
    expect(liegtInHistorie(`${o}/Historie.docx`)).toBe(false);
  });

  it("hinweisFuer: exakt vor Inhalt vor Fassung, einsortierte Kopie zuerst", () => {
    const zz = "ZZ_Dok/Vertrag.pdf";
    const gruppen: DoppelGruppe[] = [
      { gruppe: "g:1", art: "gleich", mitglieder: [
        mitglied(zz, { kopie: 1 }), mitglied("ZZ_Dok/Vertrag_1.pdf", { kopie: 1 }), mitglied("02_LOC/Vertrag.pdf", { kopie: 1 }),
        mitglied("02_LOC/Vertrag.docx", { kopie: 2 }),
      ] },
      { gruppe: "f:1", art: "fassung", mitglieder: [mitglied(zz, { rolle: "neu", kopie: null }), mitglied("02_LOC/Historie/Vertrag.pdf", { rolle: "alt", kopie: null })] },
    ];
    const h = hinweisFuer(zz, gruppen);
    expect(h?.art).toBe("exakt");
    expect(h?.andere.map((m) => m.pfad)).toEqual(["02_LOC/Vertrag.pdf", "ZZ_Dok/Vertrag_1.pdf"]);
    expect(hinweisFuer("02_LOC/Vertrag.docx", gruppen)?.art).toBe("inhalt");
    expect(hinweisFuer("02_LOC/Historie/Vertrag.pdf", gruppen)?.art).toBe("fassung_alt");
    expect(hinweisFuer(zz, [gruppen[1]])?.art).toBe("fassung_neu");
    expect(hinweisFuer("X/fremd.pdf", gruppen)).toBeNull();
    expect(hinweisFuer(zz.normalize("NFD"), gruppen)?.art).toBe("exakt");
  });

  it("behaltenPaar ist reihenfolge-unabhängig", () => {
    expect(behaltenPaar("b", "a")).toEqual(["a", "b"]);
    expect(behaltenPaar("a", "b")).toEqual(["a", "b"]);
  });
});

describe("POST /api/ablage/doppel — Quarantäne statt Löschen", () => {
  const zz = "ZZ_Dok/_EVENTLINE/Plan.pdf";
  const nas = "02_LOC/Barakuba/Plan.pdf";
  beforeEach(() => {
    db.aktuell = {
      tabellen: {
        nas_doppel: [
          { gruppe: "g:a", art: "gleich", pfad: zz, kopie: 1 },
          { gruppe: "g:a", art: "gleich", pfad: nas, kopie: 1 },
        ],
        ablage_datei_index: [
          { pfad: zz, name: "Plan.pdf", ordner_pfad: "ZZ_Dok/_EVENTLINE", geaendert: null },
          { pfad: nas, name: "Plan.pdf", ordner_pfad: "02_LOC/Barakuba", geaendert: null },
        ],
        ablage_moves: [],
        nas_vorschlaege: [{ id: "v1", art: "zz", pfad: zz, status: "offen", ziel_ordner: "02_LOC/Barakuba" }],
      },
      unique: { ablage_moves: (neu, alle) => alle.some((z) => z.pfad === neu.pfad) },
      aufrufe: [],
    };
  });
  const post = (body: unknown) => POST(new Request("http://x/api/ablage/doppel", { method: "POST", body: JSON.stringify(body) }) as never);

  it("verschiebt in 99_System/Duplikate/<Datum>/<Ordner>, löscht nie, Vorschlag → doppel", async () => {
    const res = await post({ aktion: "entfernen", pfad: zz });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.ziel).toMatch(/^99_System\/Duplikate\/\d{4}-\d{2}-\d{2}\/ZZ_Dok\/_EVENTLINE$/);
    expect(db.aktuell!.tabellen.ablage_moves).toEqual([expect.objectContaining({ pfad: zz, ziel_ordner: json.ziel })]);
    expect(db.aktuell!.tabellen.nas_vorschlaege[0]).toEqual(expect.objectContaining({ status: "doppel", gewaehlt_ordner: json.ziel }));
    expect(db.aktuell!.aufrufe.some((a) => a.op === "delete")).toBe(false);
    // Idempotent: zweiter Klick → gleiche Antwort, kein zweiter Auftrag.
    const zweit = await (await post({ aktion: "entfernen", pfad: zz })).json();
    expect(zweit).toEqual(expect.objectContaining({ success: true, ziel: json.ziel }));
    expect(db.aktuell!.tabellen.ablage_moves).toHaveLength(1);
  });

  it("nie die letzte Kopie: andere wandert schon in den Systembereich → 409", async () => {
    db.aktuell!.tabellen.ablage_moves.push({ pfad: nas, ziel_ordner: "99_System/Papierkorb" });
    const res = await post({ aktion: "entfernen", pfad: zz });
    expect(res.status).toBe(409);
    expect(db.aktuell!.tabellen.ablage_moves).toHaveLength(1);
  });

  it("nur bekannte Doppel und nur Dateien im Index", async () => {
    expect((await post({ aktion: "entfernen", pfad: "02_LOC/fremd.pdf" })).status).toBe(404);
    db.aktuell!.tabellen.ablage_datei_index = db.aktuell!.tabellen.ablage_datei_index.filter((z) => z.pfad !== zz);
    expect((await post({ aktion: "entfernen", pfad: zz })).status).toBe(409);
    expect((await post({ aktion: "entfernen", pfad: "../x" })).status).toBe(400);
    expect((await post({ aktion: "loeschen", pfad: zz })).status).toBe(400);
    expect(db.aktuell!.tabellen.ablage_moves).toHaveLength(0);
  });

  it("andere Verschiebung steht aus → 409, nichts geändert", async () => {
    db.aktuell!.tabellen.ablage_moves.push({ pfad: zz, ziel_ordner: "02_LOC/Barakuba" });
    expect((await post({ aktion: "entfernen", pfad: zz })).status).toBe(409);
    expect(db.aktuell!.tabellen.nas_vorschlaege[0].status).toBe("offen");
  });
});
