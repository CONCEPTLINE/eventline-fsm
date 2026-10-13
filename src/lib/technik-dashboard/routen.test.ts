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
        // select() ist direkt abwartbar und kennt eq().maybeSingle() (technik_steuerung)
        select: () => {
          const alle = () => ({ data: tab.map((r) => ({ ...r })), error: null });
          return Object.assign(Promise.resolve(alle()), {
            eq: (k: string, v: unknown) => ({
              maybeSingle: async () => ({ data: tab.find((r) => r[k] === v) ?? null, error: null }),
            }),
          });
        },
        insert: (rows: Array<Record<string, unknown>>) => { tab.push(...rows); return Promise.resolve({ error: null }); },
        upsert: (rows: Record<string, unknown> | Array<Record<string, unknown>>, opts: { onConflict: string }) => {
          const keys = opts.onConflict.split(",");
          for (const row of Array.isArray(rows) ? rows : [rows]) {
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
import { POST as SETZE } from "@/app/api/technik/steuerung/route";

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
    // ohne Zeile in technik_steuerung: Standard «ausgewogen»
    expect(await r1.json()).toEqual({ success: true, steuerung: { luefter_profil: "ausgewogen", stand: "1970-01-01T00:00:00.000Z" } });
    expect(zustand.tabellen.technik_stand.map((z) => z.quelle).sort()).toEqual(["ki", "rig"]);
    expect(zustand.tabellen.technik_messwerte).toHaveLength(2);

    await POST(anfrage(p));
    expect(zustand.tabellen.technik_stand).toHaveLength(2);
    expect(zustand.tabellen.technik_messwerte).toHaveLength(2);
    expect(zustand.tabellen.technik_ereignisse ?? []).toHaveLength(0);
  });

  it("antwortet dem Rig mit dem gewuenschten Luefter-Profil und speichert die Kuehlung", async () => {
    zustand.tabellen.technik_steuerung = [{ id: 1, luefter_profil: "kuehl", geaendert_am: "2026-10-14T08:00:00+00:00", geaendert_von: "u1" }];
    const p = paket();
    (p.rig as Record<string, unknown>).kuehlung = { status: "ok", profil_aktiv: "ausgewogen", pumpe_rpm: 2100, luefter: [{ nr: 1, ort: "front", rpm: 900 }], leds: "aus", geheim: "x" };
    const r = await POST(anfrage(p));
    expect(await r.json()).toEqual({ success: true, steuerung: { luefter_profil: "kuehl", stand: "2026-10-14T08:00:00.000Z" } });
    const rigStand = zustand.tabellen.technik_stand.find((z) => z.quelle === "rig")?.werte as Record<string, unknown>;
    expect(rigStand.kuehlung).toEqual({ status: "ok", profil_aktiv: "ausgewogen", pumpe_rpm: 2100, luefter: [{ nr: 1, ort: "front", rpm: 900 }], leds: "aus" });
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

describe("POST /api/technik/steuerung", () => {
  const setze = (body: unknown) => SETZE(new Request("http://localhost/api/technik/steuerung", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  beforeEach(() => {
    zustand.tabellen = {};
  });

  it("401 ohne Anmeldung, 403 fuer Nicht-Admins — nichts gespeichert", async () => {
    zustand.user = null;
    expect((await setze({ luefter_profil: "kuehl" })).status).toBe(401);
    zustand.user = { id: "u1" };
    zustand.rolle = "mitarbeiter";
    expect((await setze({ luefter_profil: "kuehl" })).status).toBe(403);
    expect(zustand.tabellen.technik_steuerung).toBeUndefined();
  });

  it("400 bei unbekanntem Profil oder kaputtem JSON", async () => {
    zustand.user = { id: "u1" };
    zustand.rolle = "admin";
    expect((await setze({ luefter_profil: "turbo" })).status).toBe(400);
    expect((await setze({})).status).toBe(400);
    expect((await setze("{kaputt")).status).toBe(400);
    expect(zustand.tabellen.technik_steuerung).toBeUndefined();
  });

  it("Admin setzt das Profil mit geaendert_von/geaendert_am, ohne Cache", async () => {
    zustand.user = { id: "admin-1" };
    zustand.rolle = "admin";
    const r = await setze({ luefter_profil: "leise" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = await r.json();
    expect(j).toMatchObject({ success: true, steuerung: { luefter_profil: "leise" } });
    expect(zustand.tabellen.technik_steuerung).toEqual([
      { id: 1, luefter_profil: "leise", geaendert_von: "admin-1", geaendert_am: j.steuerung.geaendert_am },
    ]);
    await setze({ luefter_profil: "kuehl" });
    expect(zustand.tabellen.technik_steuerung).toHaveLength(1);
    expect(zustand.tabellen.technik_steuerung[0].luefter_profil).toBe("kuehl");
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
