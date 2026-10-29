import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Admin-Client und Logger gemockt: der Test schreibt nie in die Datenbank.
const zustand = vi.hoisted(() => ({
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  profil: { id: "48767098-1686-4a4f-bcca-973ab61a2fab", is_active: true } as { id: string; is_active: boolean } | null,
  logs: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: table === "profiles" ? zustand.profil : null, error: null }),
        insert: async (row: Record<string, unknown>) => {
          zustand.inserts.push({ table, row });
          return { error: null };
        },
      };
      return q;
    },
  }),
}));

vi.mock("@/lib/log", () => ({
  logError: (ctx: string) => {
    zustand.logs.push(ctx);
  },
}));

import { lenaAndereMethoden, lenaPost, type LenaErgebnis, type LenaKontext } from "@/lib/lena/server";

const TOKEN = "t".repeat(48);
const UID = "48767098-1686-4a4f-bcca-973ab61a2fab";
const URL = "https://app.test/api/lena/auftrag-notiz";

function anfrage(opts: { token?: string | null; anrufer?: string; body?: string; method?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (opts.anrufer !== undefined) headers.set("x-lena-anrufer", opts.anrufer);
  const method = opts.method ?? "POST";
  return new Request(URL, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : opts.body ?? JSON.stringify({ auftrag_nr: "INT-26292", text: "Geheimer Inhalt" }),
  });
}

const okHandler = vi.fn(async (ctx: LenaKontext): Promise<LenaErgebnis> => ({
  antwort: { ok: true, text: "Notiz abgelegt." },
  ergebnis: `Notiz abgelegt fuer ${ctx.userId}`,
}));

beforeEach(() => {
  zustand.inserts.length = 0;
  zustand.logs.length = 0;
  zustand.profil = { id: UID, is_active: true };
  okHandler.mockClear();
  vi.stubEnv("LENA_TOKEN", TOKEN);
  vi.stubEnv("LENA_USER_ID", UID);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const protokoll = () => {
  expect(zustand.inserts).toHaveLength(1);
  expect(zustand.inserts[0].table).toBe("lena_protokoll");
  return zustand.inserts[0].row;
};

describe("lenaPost — Pruefreihenfolge und Protokoll", () => {
  it("ohne konfigurierten Token: 503, Endpunkt laeuft nicht, Body ungelesen", async () => {
    vi.stubEnv("LENA_TOKEN", "");
    const req = anfrage();
    const res = await lenaPost(req, "auftrag-notiz", okHandler);
    expect(res.status).toBe(503);
    expect(okHandler).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
    expect(protokoll()).toMatchObject({ endpunkt: "auftrag-notiz", ok: false, eingabe: null, ergebnis: "503 LENA_TOKEN fehlt" });
  });

  it("falscher oder fehlender Token: 401, nichts gelesen, nichts geschrieben ausser Protokoll", async () => {
    for (const token of [null, "falsch", "t".repeat(47), "t".repeat(49), "u".repeat(48)]) {
      zustand.inserts.length = 0;
      const req = anfrage({ token });
      const res = await lenaPost(req, "auftrag-notiz", okHandler);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, text: "Dieser Zugriff ist nicht erlaubt." });
      expect(req.bodyUsed).toBe(false);
      expect(protokoll()).toMatchObject({ ok: false, eingabe: null });
    }
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("falscher Anrufer: 403 trotz richtigem Token", async () => {
    const req = anfrage({ anrufer: "+41 79 000 00 00" });
    const res = await lenaPost(req, "auftrag-notiz", okHandler);
    expect(res.status).toBe(403);
    expect(okHandler).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
    expect(protokoll()).toMatchObject({ anrufer: "+41790000000", ok: false, ergebnis: "403 Anrufer nicht erlaubt" });
  });

  it("ohne LENA_USER_ID: 503", async () => {
    vi.stubEnv("LENA_USER_ID", "kein-uuid");
    const res = await lenaPost(anfrage(), "auftrag-notiz", okHandler);
    expect(res.status).toBe(503);
    expect(okHandler).not.toHaveBeenCalled();
    expect(zustand.logs).toContain("lena.konfiguration");
  });

  it("kein JSON / kein Objekt: 400", async () => {
    for (const body of ["{kaputt", "[1,2]", "null", "42"]) {
      zustand.inserts.length = 0;
      const res = await lenaPost(anfrage({ body }), "auftrag-notiz", okHandler);
      expect(res.status).toBe(400);
      expect(protokoll()).toMatchObject({ ok: false, eingabe: null });
    }
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("zu grosser Body: 413", async () => {
    const res = await lenaPost(anfrage({ body: JSON.stringify({ text: "x".repeat(20_000) }) }), "auftrag-notiz", okHandler);
    expect(res.status).toBe(413);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("inaktives oder fehlendes Profil: 503", async () => {
    zustand.profil = { id: UID, is_active: false };
    expect((await lenaPost(anfrage(), "auftrag-notiz", okHandler)).status).toBe(503);
    zustand.profil = null;
    expect((await lenaPost(anfrage(), "auftrag-notiz", okHandler)).status).toBe(503);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("Erfolg: Endpunkt mit Profil-ID, Protokoll ohne Notiztext", async () => {
    const res = await lenaPost(anfrage({ anrufer: "+41782049521" }), "auftrag-notiz", okHandler);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, text: "Notiz abgelegt." });
    expect(okHandler).toHaveBeenCalledTimes(1);
    expect(okHandler.mock.calls[0][0].userId).toBe(UID);
    expect(okHandler.mock.calls[0][0].body).toEqual({ auftrag_nr: "INT-26292", text: "Geheimer Inhalt" });
    const row = protokoll();
    expect(row).toMatchObject({ ok: true, anrufer: "+41782049521", eingabe: { auftrag_nr: "INT-26292", text_laenge: 15 } });
    expect(JSON.stringify(row)).not.toContain("Geheimer");
  });

  it("Fehler im Endpunkt: 500 mit harmloser Meldung, Details nur im Log", async () => {
    const kaputt = vi.fn(async (): Promise<LenaErgebnis> => {
      throw new Error("jobs: 42P01 relation geheim");
    });
    const res = await lenaPost(anfrage(), "auftrag-notiz", kaputt);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("42P01");
    expect(zustand.logs).toContain("lena.auftrag-notiz");
    expect(protokoll()).toMatchObject({ ok: false, ergebnis: "500 interner Fehler" });
  });
});

describe("lenaAndereMethoden", () => {
  it("GET/DELETE: 405 mit Allow POST und Protokoll", async () => {
    const m = lenaAndereMethoden("termine-abfragen");
    for (const [fn, method] of [[m.GET, "GET"], [m.DELETE, "DELETE"]] as const) {
      zustand.inserts.length = 0;
      const res = await fn(anfrage({ method }));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(protokoll()).toMatchObject({ endpunkt: "termine-abfragen", ok: false, eingabe: { methode: method } });
    }
  });
});
