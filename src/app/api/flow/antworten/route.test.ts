// POST /api/flow/antworten — Vertrag mit Trust flow («Fragen an dich», Migration 376):
// Ausweis (aud erp-antworten, Ed25519, 60 s, jti einmalig), Claims profil_ids/fragen,
// Antwort { v: 1, antworten: [{ profil_id, frage, antwort, text_version, beantwortet_am }] },
// je Person und Frage nur die neueste, keine anderen Daten; Fehler wie /api/flow/stempel.
// Datenbank als Attrappe mit den Regeln von flow_abruf_beginnen (369/376).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claims, signiere, testSchluessel } from "@/lib/flow/test-hilfen";

type Zeile = { id: string; profile_id: string; frage_schluessel: string; antwort: string; text_version: string; beantwortet_at: string; quelle?: string; akteur_name?: string };

const z = vi.hoisted(() => ({
  abrufe: [] as { id: string; jti: string; aud: string; angefragt: number | null; status: string; geliefert?: number | null; sha?: string | null; grund?: string | null }[],
  antworten: [] as Zeile[],
  wartung: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/wartung-server", () => ({ ladeWartung: async () => ({ bereiche: z.wartung ? ["lohn"] : [] }) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    async rpc(name: string, p: Record<string, unknown>) {
      if (name === "flow_abruf_beginnen") {
        const zaehlt = (a: { status: string }) => a.status !== "wiederholt" && a.status !== "zu_viele";
        if (z.abrufe.some((a) => zaehlt(a) && a.jti === p.p_jti)) {
          z.abrufe.push({ id: `w${z.abrufe.length}`, jti: p.p_jti as string, aud: p.p_aud as string, angefragt: p.p_angefragt as number, status: "wiederholt" });
          return { data: { status: "wiederholt" }, error: null };
        }
        if (z.abrufe.filter(zaehlt).length >= 10) {
          z.abrufe.push({ id: `z${z.abrufe.length}`, jti: p.p_jti as string, aud: p.p_aud as string, angefragt: p.p_angefragt as number, status: "zu_viele" });
          return { data: { status: "zu_viele", retry_after: 42 }, error: null };
        }
        const id = `id${z.abrufe.length}`;
        z.abrufe.push({ id, jti: p.p_jti as string, aud: p.p_aud as string, angefragt: p.p_angefragt as number, status: "angenommen" });
        return { data: { status: "ok", id }, error: null };
      }
      if (name === "flow_abruf_abschliessen") {
        const a = z.abrufe.find((x) => x.id === p.p_id && x.status === "angenommen");
        if (!a) return { data: null, error: { message: "läuft nicht" } };
        Object.assign(a, { status: p.p_status, geliefert: p.p_geliefert, sha: p.p_antwort_sha256, grund: p.p_grund });
        return { data: null, error: null };
      }
      throw new Error(`unerwartete rpc ${name}`);
    },
    from(tabelle: string) {
      if (tabelle !== "mitarbeiter_antworten") throw new Error(`unerwartete Tabelle ${tabelle}`);
      const filter: [string, unknown[]][] = [];
      const b = {
        select: () => b,
        in: (spalte: string, werte: unknown[]) => { filter.push([spalte, werte]); return b; },
        order: () => b,
        range: async (von: number, bis: number) => {
          const rows = z.antworten
            .filter((r) => filter.every(([s, w]) => w.includes((r as Record<string, unknown>)[s])))
            .sort((x, y) => x.id.localeCompare(y.id))
            .slice(von, bis + 1)
            // Nur die abgefragten Spalten (wie select(...)) — Rest der Zeile bleibt in der «Datenbank».
            .map((r) => ({ id: r.id, profile_id: r.profile_id, frage_schluessel: r.frage_schluessel, antwort: r.antwort, text_version: r.text_version, beantwortet_at: r.beantwortet_at }));
          return { data: rows, error: null };
        },
      };
      return b;
    },
  }),
}));

import { POST } from "./route";

const k = testSchluessel();
const P1 = "a0000000-0000-4000-8000-000000000011";
const P2 = "a0000000-0000-4000-8000-000000000012";
const P3 = "a0000000-0000-4000-8000-000000000013";
const jetzt = () => Math.floor(Date.now() / 1000);

function ausweis(extra: Record<string, unknown> = {}, aud: Parameters<typeof claims>[0] = "erp-antworten", schluessel = k.privat) {
  // Nur die Claims dieser Route (ohne die Stempel-Claims aus claims()).
  const basis = claims(aud, jetzt());
  for (const stempelClaim of ["jahr", "monat", "von", "bis", "profile"]) delete basis[stempelClaim];
  return signiere(schluessel, { ...basis, profil_ids: [P1, P2, P3], fragen: ["ahv_geringfuegig"], ...extra });
}

function senden(body: string) {
  return POST(new Request("http://localhost/api/flow/antworten", { method: "POST", headers: { "Content-Type": "application/jose" }, body }));
}

beforeEach(() => {
  process.env.FLOW_ABRUF_PUBLIC_KEY = k.oeffentlichB64;
  z.abrufe = [];
  z.wartung = false;
  z.antworten = [
    // P1: geändert — es gilt die neueste (keine)
    { id: "1", profile_id: P1, frage_schluessel: "ahv_geringfuegig", antwort: "abziehen", text_version: "1.0", beantwortet_at: "2026-11-03T08:00:00+00:00", quelle: "selbst", akteur_name: "Test Eins" },
    { id: "2", profile_id: P1, frage_schluessel: "ahv_geringfuegig", antwort: "keine", text_version: "1.0", beantwortet_at: "2026-11-03T09:30:00.123456+00:00", quelle: "selbst", akteur_name: "Test Eins" },
    // P2: eine Antwort
    { id: "3", profile_id: P2, frage_schluessel: "ahv_geringfuegig", antwort: "abziehen", text_version: "1.0", beantwortet_at: "2026-11-02T12:00:00+00:00", quelle: "selbst" },
    // P3: keine Antwort. Fremde Person: nie in der Antwort.
    { id: "4", profile_id: "a0000000-0000-4000-8000-000000000099", frage_schluessel: "ahv_geringfuegig", antwort: "keine", text_version: "1.0", beantwortet_at: "2026-11-02T12:00:00+00:00" },
  ];
});

describe("POST /api/flow/antworten", () => {
  it("200: je Person und Frage nur die neueste Antwort, fehlende nicht enthalten, keine anderen Felder", async () => {
    const r = await senden(ausweis());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toEqual({
      v: 1,
      antworten: [
        { profil_id: P1, frage: "ahv_geringfuegig", antwort: "keine", text_version: "1.0", beantwortet_am: "2026-11-03T09:30:00.123Z" },
        { profil_id: P2, frage: "ahv_geringfuegig", antwort: "abziehen", text_version: "1.0", beantwortet_am: "2026-11-02T12:00:00.000Z" },
      ],
    });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("X-Antwort-Sha256")).toMatch(/^[0-9a-f]{64}$/);
    expect(z.abrufe).toEqual([expect.objectContaining({ aud: "erp-antworten", angefragt: 3, status: "ok", geliefert: 2 })]);
  });

  it("IDs gross geschrieben → Antwort klein (wie angefragt normalisiert)", async () => {
    const r = await senden(ausweis({ profil_ids: [P2.toUpperCase()] }));
    expect(r.status).toBe(200);
    expect((await r.json()).antworten.map((a: { profil_id: string }) => a.profil_id)).toEqual([P2]);
  });

  it("500 Profil-IDs passen in einen Ausweis; 501 → 400 profile_zu_viele", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const gross = ausweis({ profil_ids: ids(500) });
    expect(gross.length).toBeGreaterThan(16_000); // grösser als ein Stempel-Ausweis
    expect((await senden(gross)).status).toBe(200);
    const r = await senden(ausweis({ profil_ids: ids(501) }));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("profile_zu_viele");
  });

  it("Claims ungültig → 400 mit Code, im Protokoll «abgelehnt»", async () => {
    const faelle: [Record<string, unknown>, string][] = [
      [{ profil_ids: [] }, "profile_fehlen"],
      [{ profil_ids: ["x"] }, "profile_ungueltig"],
      [{ profil_ids: [P1, P1] }, "profile_doppelt"],
      [{ fragen: [] }, "fragen_fehlen"],
      [{ fragen: ["Gross"] }, "frage_ungueltig"],
      [{ fragen: ["ahv_geringfuegig", "ahv_geringfuegig"] }, "fragen_doppelt"],
      [{ fragen: ["gibt_es_nicht"] }, "frage_unbekannt"],
    ];
    for (const [extra, code] of faelle) {
      const r = await senden(ausweis(extra));
      expect(r.status, code).toBe(400);
      expect((await r.json()).code).toBe(code);
    }
    expect(z.abrufe.every((a) => a.status === "abgelehnt")).toBe(true);
  });

  it("401: fremder Schlüssel, falscher aud (Stempel-Ausweis), abgelaufen, kaputt — nichts protokolliert", async () => {
    const fremd = ausweis({}, "erp-antworten", testSchluessel().privat);
    const aud = ausweis({}, "erp-stempel");
    const alt = ausweis({ iat: jetzt() - 200, exp: jetzt() - 140 });
    for (const t of [fremd, aud, alt, "kaputt.kaputt.kaputt"]) {
      const r = await senden(t);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ success: false, code: "ausweis_ungueltig", error: "Ausweis ungültig." });
    }
    expect(z.abrufe).toHaveLength(0);
  });

  it("409: derselbe Ausweis zweimal", async () => {
    const t = ausweis();
    expect((await senden(t)).status).toBe(200);
    const r = await senden(t);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("ausweis_verwendet");
  });

  it("429: mehr als 10 je Minute (Gruppe «abruf»), mit Retry-After", async () => {
    for (let i = 0; i < 10; i++) expect((await senden(ausweis())).status).toBe(200);
    const r = await senden(ausweis());
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("42");
    expect((await r.json()).code).toBe("zu_viele");
  });

  it("503: Wartung «lohn» (Ausweis unverbraucht) und ohne öffentlichen Schlüssel", async () => {
    z.wartung = true;
    const w = await senden(ausweis());
    expect(w.status).toBe(503);
    expect((await w.json()).code).toBe("wartung");
    expect(z.abrufe).toHaveLength(0);
    z.wartung = false;
    delete process.env.FLOW_ABRUF_PUBLIC_KEY;
    const n = await senden(ausweis());
    expect(n.status).toBe(503);
    expect((await n.json()).code).toBe("nicht_eingerichtet");
  });

  it("413: Körper zu gross", async () => {
    const r = await senden("x".repeat(90_000));
    expect(r.status).toBe(413);
    expect((await r.json()).code).toBe("zu_gross");
  });
});
