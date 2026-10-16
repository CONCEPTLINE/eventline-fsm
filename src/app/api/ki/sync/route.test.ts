// GET /api/ki/sync — leichte Spur (16.10.2026): mit ?nur=… beansprucht die Abholung NUR leichte Arten (Vorschau),
// nie einen schweren Auftrag, und setzt nichts zurueck; jede Abhol-Antwort nennt die leichten Arten.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeAdmin, type FakeDb } from "@/lib/ki/test-fake-db";

const zustand = vi.hoisted(() => ({ db: null as unknown as FakeDb }));

vi.mock("@/lib/ki/rig-auth", () => ({ rigAuthFehler: () => null }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/ki/kontext", () => ({
  ladeAblageKontext: async () => ({ ordner: [], dok_typen: [], mitarbeiter: [], namen_alle: [], heute: "2026-10-16" }),
  ladeWissenSicher: async () => [],
}));
vi.mock("@/lib/ki/queue", async (original) => ({
  ...(await original<typeof import("@/lib/ki/queue")>()),
  raeumeKiAuf: vi.fn(async () => ({})),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...fakeAdmin(zustand.db),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://x.test/datei?sig=1" }, error: null }) }) },
  }),
}));

import { GET } from "./route";
import { leseNurArten } from "@/lib/ki/queue";

const ALT = new Date(Date.now() - 30 * 60_000).toISOString();
const TMP = "ki-tmp/0f0e0d0c-0b0a-4908-8706-050403020100";

function auftrag(id: string, art: string, prioritaet: number, created_at: string, extra: Record<string, unknown> = {}) {
  return { id, art, prioritaet, created_at, status: "offen", versuche: 0, payload: {}, ...extra };
}

function abholen(params: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/ki/sync?modell=gemma3:4b&arten=ablage_analyse,diktat,vorschau&${params}`));
}

beforeEach(() => {
  zustand.db = {
    aufrufe: [],
    tabellen: {
      ki_status: [{ id: 1, letzter_poll: new Date().toISOString(), online_seit: ALT, eilig_bis: null }],
      ki_auftraege: [
        auftrag("a1", "ablage_analyse", 50, "2026-10-16T10:00:00Z", { payload: { storage_path: TMP, file_name: "x.pdf" } }),
        auftrag("d1", "diktat", 100, "2026-10-16T10:01:00Z", { payload: { storage_path: TMP } }),
        auftrag("v1", "vorschau", 95, "2026-10-16T10:02:00Z", { payload: { pfad: "A/b.pdf", breite: 900 } }),
        // Ein langer Auftrag, der seit 30 min laeuft (das Rig arbeitet noch daran).
        { id: "l1", art: "ablage_analyse", prioritaet: 50, created_at: ALT, status: "laeuft", started_at: ALT, versuche: 1, payload: {} },
      ],
    },
  };
});

describe("GET /api/ki/sync — leichte Spur", () => {
  it("nur=vorschau: beansprucht nur die Vorschau, setzt den laufenden Auftrag nicht zurueck, nennt leichte_arten", async () => {
    const r = await abholen("nur=vorschau");
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.auftraege.map((a: { id: string }) => a.id)).toEqual(["v1"]);
    expect(j.leichte_arten).toEqual(["vorschau"]);
    const t = zustand.db.tabellen.ki_auftraege;
    expect(t.find((z) => z.id === "v1")).toMatchObject({ status: "laeuft", versuche: 1 });
    expect(t.find((z) => z.id === "a1")?.status).toBe("offen");
    expect(t.find((z) => z.id === "d1")?.status).toBe("offen");
    expect(t.find((z) => z.id === "l1")?.status).toBe("laeuft");
    // Der Herzschlag der leichten Spur haelt die vollen Faehigkeiten fest (nicht nur «vorschau»).
    expect(zustand.db.tabellen.ki_status[0].arten).toEqual(["ablage_analyse", "diktat", "vorschau"]);
  });

  it("nur mit schweren oder unbekannten Arten: beansprucht nichts", async () => {
    for (const nur of ["diktat,ablage_analyse", "erfunden", ""]) {
      const j = await (await abholen(`nur=${nur}`)).json();
      expect(j.auftraege).toEqual([]);
    }
    expect(zustand.db.tabellen.ki_auftraege.filter((z) => z.status === "laeuft").map((z) => z.id)).toEqual(["l1"]);
  });

  it("ohne Vorschau offen: leer, auch wenn schwere Auftraege warten", async () => {
    zustand.db.tabellen.ki_auftraege = zustand.db.tabellen.ki_auftraege.filter((z) => z.id !== "v1");
    const j = await (await abholen("nur=vorschau")).json();
    expect(j.auftraege).toEqual([]);
  });

  it("normale Abholung wie bisher: Diktat zuerst, Haengende zurueck, leichte_arten in der Antwort", async () => {
    const j = await (await abholen("")).json();
    expect(j.auftraege.map((a: { id: string }) => a.id)).toEqual(["d1"]);
    expect(j.auftraege[0].payload.url).toContain("https://x.test/");
    expect(j.leichte_arten).toEqual(["vorschau"]);
    expect(zustand.db.tabellen.ki_auftraege.find((z) => z.id === "l1")?.status).toBe("offen");
  });
});

describe("leseNurArten", () => {
  it("nur leichte Arten, ohne Doppel; fehlt der Parameter: normale Abholung", () => {
    expect(leseNurArten(null)).toBeUndefined();
    expect(leseNurArten("vorschau, vorschau,diktat,nas_suche")).toEqual(["vorschau"]);
    expect(leseNurArten("")).toEqual([]);
  });
});
