// Anmeldung und Ingest der Technik-Routen mit Attrappen (keine echte DB).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const zustand = vi.hoisted(() => ({
  user: null as null | { id: string },
  rolle: "mitarbeiter",
  tabellen: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: zustand.user }, error: null }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { role: zustand.rolle }, error: null }) }) }),
    }),
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/technik-dashboard/stand-server", () => ({
  ladeTechnikStand: vi.fn(async () => ({ success: true, hat_daten: false })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      zustand.tabellen[t] ??= [];
      const tab = zustand.tabellen[t];
      return {
        select: () => Promise.resolve({ data: tab.map((r) => ({ ...r })), error: null }),
        insert: (rows: Array<Record<string, unknown>>) => { tab.push(...rows); return Promise.resolve({ error: null }); },
        upsert: (rows: Array<Record<string, unknown>>, opts: { onConflict: string }) => {
          const keys = opts.onConflict.split(",");
          for (const row of rows) {
            const i = tab.findIndex((r) => keys.every((k) => r[k] === row[k]));
            if (i >= 0) tab[i] = { ...row };
            else tab.push({ ...row });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

import { POST } from "@/app/api/technik/messwerte/route";
import { GET } from "@/app/api/technik/stand/route";

const TOKEN = "t".repeat(40);

function paket(over: Record<string, unknown> = {}) {
  const jetzt = Date.now();
  return {
    v: 1,
    gesendet_am: new Date(jetzt - 5_000).toISOString(),
    rig: {
      gemessen_am: new Date(jetzt - 10_000).toISOString(),
      uptime_s: 1000,
      cpu: { temp_c: 70 },
      dienste: [{ name: "ki_dienst", zustand: "laeuft", gesund: true, neustarts: 0, gestartet_am: new Date(jetzt - 900_000).toISOString() }],
      minute: { "cpu.temp": 70 },
    },
    ki: { warteschlange: 0, fsm_antwort_ms: 200 },
    ...over,
  };
}

function anfrage(body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/technik/messwerte", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
    body: text,
  });
}

describe("POST /api/technik/messwerte", () => {
  const alt = process.env.KI_SYNC_TOKEN;
  beforeEach(() => {
    process.env.KI_SYNC_TOKEN = TOKEN;
    zustand.tabellen = {};
  });
  afterEach(() => {
    process.env.KI_SYNC_TOKEN = alt;
  });

  it("503 ohne konfiguriertes Secret", async () => {
    delete process.env.KI_SYNC_TOKEN;
    expect((await POST(anfrage(paket()))).status).toBe(503);
  });

  it("401 ohne oder mit falschem Token", async () => {
    expect((await POST(anfrage(paket(), { authorization: "" }))).status).toBe(401);
    expect((await POST(anfrage(paket(), { authorization: `Bearer ${"x".repeat(40)}` }))).status).toBe(401);
    expect(zustand.tabellen.technik_stand).toBeUndefined();
  });

  it("413 ueber 64 KiB, 415 ohne JSON, 400 bei kaputtem JSON oder falscher Version", async () => {
    const gross = paket({ polster: "x".repeat(70 * 1024) });
    expect((await POST(anfrage(gross))).status).toBe(413);
    expect((await POST(anfrage(paket(), { "content-type": "text/plain" }))).status).toBe(415);
    expect((await POST(anfrage("{kaputt"))).status).toBe(400);
    const r = await POST(anfrage(paket({ v: 2 })));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ success: false, error: "version" });
  });

  it("speichert Stand und Minutenwerte; dasselbe Paket zweimal ist idempotent", async () => {
    const p = paket();
    const r1 = await POST(anfrage(p));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ success: true });
    expect(zustand.tabellen.technik_stand.map((z) => z.quelle).sort()).toEqual(["ki", "rig"]);
    expect(zustand.tabellen.technik_messwerte).toHaveLength(2);

    await POST(anfrage(p));
    expect(zustand.tabellen.technik_stand).toHaveLength(2);
    expect(zustand.tabellen.technik_messwerte).toHaveLength(2);
    expect(zustand.tabellen.technik_ereignisse ?? []).toHaveLength(0);
  });

  it("leitet einen Dienst-Absturz als Ereignis ab", async () => {
    const p = paket();
    await POST(anfrage(p));
    const neu = structuredClone(p);
    (neu.rig.dienste[0] as { neustarts: number }).neustarts = 1;
    neu.rig.gemessen_am = new Date(Date.now() - 1_000).toISOString();
    await POST(anfrage(neu));
    expect(zustand.tabellen.technik_ereignisse).toEqual([
      expect.objectContaining({ art: "absturz", stufe: "warnung", schluessel: "dienst.ki_dienst", text: "KI-Dienst unerwartet neu gestartet" }),
    ]);
  });
});

describe("GET /api/technik/stand", () => {
  const req = (q = "") => new Request(`http://localhost/api/technik/stand${q}`);

  it("401 ohne Anmeldung", async () => {
    zustand.user = null;
    expect((await GET(req())).status).toBe(401);
  });

  it("403 fuer Nicht-Admins", async () => {
    zustand.user = { id: "u1" };
    zustand.rolle = "mitarbeiter";
    expect((await GET(req())).status).toBe(403);
  });

  it("200 fuer Admins, ohne Cache", async () => {
    zustand.user = { id: "u1" };
    zustand.rolle = "admin";
    const r = await GET(req("?bereich=7d&reihen=1"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { ladeTechnikStand } = await import("@/lib/technik-dashboard/stand-server");
    expect(ladeTechnikStand).toHaveBeenLastCalledWith(expect.anything(), { bereich: "7d", reihen: true });
    await GET(req("?bereich=1y"));
    expect(ladeTechnikStand).toHaveBeenLastCalledWith(expect.anything(), { bereich: "6h", reihen: false });
  });
});
