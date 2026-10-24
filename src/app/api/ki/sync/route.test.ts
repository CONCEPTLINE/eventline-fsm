// GET/POST /api/ki/sync — Abholung im ERP nur noch fuer Diktat, Beleg und Warenkorb (seit 24.10.2026 bedient Trust one
// die Ablage-Arten): Diktate zuerst, Haengende zurueck, fremde Arten (Altbestand der Ablage) nie herausgeben;
// Ergebnisse nur fuer laufende Auftraege, das Tmp-Objekt danach weg.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeAdmin, type FakeDb } from "@/lib/ki/test-fake-db";

const zustand = vi.hoisted(() => ({ db: null as unknown as FakeDb, entfernt: [] as string[] }));

vi.mock("@/lib/ki/rig-auth", () => ({ rigAuthFehler: () => null }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/ki/queue", async (original) => ({
  ...(await original<typeof import("@/lib/ki/queue")>()),
  raeumeKiAuf: vi.fn(async () => ({})),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...fakeAdmin(zustand.db),
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://x.test/datei?sig=1" }, error: null }),
        remove: async (pfade: string[]) => {
          zustand.entfernt.push(...pfade);
          return { data: null, error: null };
        },
      }),
    },
  }),
}));

import { GET, POST } from "./route";

const ALT = new Date(Date.now() - 30 * 60_000).toISOString();
const TMP = "ki-tmp/0f0e0d0c-0b0a-4908-8706-050403020100";
const A1 = "a1a1a1a1-0000-4000-8000-000000000001";
const B1 = "b1b1b1b1-0000-4000-8000-000000000001";
const D1 = "d1d1d1d1-0000-4000-8000-000000000001";
const L1 = "e1e1e1e1-0000-4000-8000-000000000001";

function auftrag(id: string, art: string, prioritaet: number, created_at: string, extra: Record<string, unknown> = {}) {
  return { id, art, prioritaet, created_at, status: "offen", versuche: 0, payload: { storage_path: TMP }, ...extra };
}

function abholen(params = ""): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/ki/sync?modell=gemma3:4b&arten=diktat,ablage_analyse&${params}`));
}

function melden(ergebnisse: unknown[]): Promise<Response> {
  return POST(new NextRequest("http://localhost/api/ki/sync", { method: "POST", body: JSON.stringify({ ergebnisse }) }));
}

const zeile = (id: string) => zustand.db.tabellen.ki_auftraege.find((z) => z.id === id);

beforeEach(() => {
  zustand.entfernt = [];
  zustand.db = {
    aufrufe: [],
    tabellen: {
      ki_status: [{ id: 1, letzter_poll: new Date().toISOString(), online_seit: ALT }],
      ki_auftraege: [
        // Altbestand der Ablage (zieht nach Trust one) — das ERP gibt ihn nie heraus.
        auftrag(A1, "ablage_analyse", 50, "2026-10-16T09:00:00Z"),
        auftrag(B1, "beleg_analyse", 50, "2026-10-16T10:01:00Z"),
        auftrag(D1, "diktat", 100, "2026-10-16T10:02:00Z"),
        // Ein Beleg, der seit 30 min «laeuft» (Rig abgestuerzt).
        auftrag(L1, "beleg_analyse", 50, "2026-10-16T08:00:00Z", { status: "laeuft", started_at: ALT, versuche: 1 }),
      ],
    },
  };
});

describe("GET /api/ki/sync — Abholung", () => {
  it("Diktat zuerst mit signierter URL, Haengende zurueck auf offen, Herzschlag ohne Ablage-Felder", async () => {
    const r = await abholen();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.auftraege.map((a: { id: string }) => a.id)).toEqual([D1]);
    expect(j.auftraege[0].payload.url).toContain("https://x.test/");
    expect(j).not.toHaveProperty("leichte_arten");
    expect(j).not.toHaveProperty("naechster_poll_ms");
    expect(zeile(D1)).toMatchObject({ status: "laeuft", versuche: 1 });
    expect(zeile(L1)?.status).toBe("offen");
    expect(zustand.db.tabellen.ki_status[0]).toMatchObject({ modell: "gemma3:4b" });
    expect(zustand.db.tabellen.ki_status[0]).not.toHaveProperty("arten");
  });

  it("danach Beleg/Warenkorb — nie eine fremde Art", async () => {
    zustand.db.tabellen.ki_auftraege = zustand.db.tabellen.ki_auftraege.filter((z) => z.id !== D1 && z.id !== L1);
    expect((await (await abholen()).json()).auftraege.map((a: { id: string }) => a.id)).toEqual([B1]);
    expect((await (await abholen()).json()).auftraege).toEqual([]);
    expect(zeile(A1)?.status).toBe("offen");
  });

  it("nur_herzschlag: nichts beanspruchen, nichts zuruecksetzen", async () => {
    const j = await (await abholen("nur_herzschlag=1")).json();
    expect(j.auftraege).toEqual([]);
    expect(zeile(D1)?.status).toBe("offen");
    expect(zeile(L1)?.status).toBe("laeuft");
  });
});

describe("POST /api/ki/sync — Ergebnisse", () => {
  it("nur fuer laufende Auftraege; Diktat bereinigt, Tmp-Objekt weg", async () => {
    Object.assign(zeile(D1)!, { status: "laeuft", started_at: new Date().toISOString() });
    const j = await (
      await melden([
        { id: D1, ok: true, ergebnis: { text: "  Hallo Welt  ", dauer_ms: 1200.4 } },
        { id: B1, ok: true, ergebnis: { ok: true, issues: [], extracted: {} } },
      ])
    ).json();
    expect(j).toEqual({ success: true, verarbeitet: 1 });
    expect(zeile(D1)).toMatchObject({ status: "fertig", ergebnis: { text: "Hallo Welt", dauer_ms: 1200 } });
    expect(zeile(B1)?.status).toBe("offen");
    expect(zustand.entfernt).toEqual([TMP]);
  });

  it("Fehler des Rigs: voller Text am Auftrag, in ki_status nur die Art", async () => {
    const j = await (await melden([{ id: L1, ok: false, fehler: "Bild unlesbar" }])).json();
    expect(j.verarbeitet).toBe(1);
    expect(zeile(L1)).toMatchObject({ status: "fehler", fehler: "Bild unlesbar" });
    expect(zustand.db.tabellen.ki_status[0].letzter_fehler).toBe("beleg_analyse: Lokale KI meldet einen Fehler");
  });

  it("fremde Art (Altbestand) bekommt kein gueltiges Ergebnis", async () => {
    Object.assign(zeile(A1)!, { status: "laeuft" });
    await melden([{ id: A1, ok: true, ergebnis: { ordner: "01_FINANZEN" } }]);
    expect(zeile(A1)).toMatchObject({ status: "fehler", fehler: "Lokale KI hat kein gültiges Ergebnis geliefert" });
  });
});
