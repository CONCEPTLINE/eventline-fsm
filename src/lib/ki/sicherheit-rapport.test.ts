// Sicherheits-Rapport (security_runs.narrative): reine Pruefung + Route
// /api/ki/sicherheit mit Attrappen (keine echte DB).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RAPPORT_MAX,
  RAPPORT_MAX_BEFUNDE,
  laufFuersRig,
  leseRapportBody,
  pruefeRapport,
  saeubereRapport,
  type BefundRoh,
} from "./sicherheit-rapport";

type Zeile = Record<string, unknown>;
const db = vi.hoisted(() => ({ tabellen: {} as Record<string, Zeile[]>, fehler: null as null | { code: string } }));

vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      const filter: Array<(r: Zeile) => boolean> = [];
      let aenderung: Zeile | null = null;
      let ordnung: { k: string; auf: boolean } | null = null;
      let grenze = Infinity;
      const ergebnis = () => {
        if (db.fehler) return { data: null, error: db.fehler };
        let rows = (db.tabellen[t] ?? []).filter((r) => filter.every((f) => f(r)));
        if (aenderung) {
          for (const r of rows) Object.assign(r, aenderung);
          return { data: rows.map((r) => ({ id: r.id })), error: null };
        }
        if (ordnung) {
          const { k, auf } = ordnung;
          rows = [...rows].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (auf ? 1 : -1));
        }
        return { data: rows.slice(0, grenze).map((r) => ({ ...r })), error: null };
      };
      const b = {
        select: () => b,
        update: (z: Zeile) => ((aenderung = z), b),
        eq: (k: string, v: unknown) => (filter.push((r) => r[k] === v), b),
        is: (k: string, v: unknown) => (filter.push((r) => r[k] === v), b),
        not: (k: string, _op: string, v: unknown) => (filter.push((r) => r[k] !== v && r[k] !== undefined), b),
        gte: (k: string, v: string) => (filter.push((r) => String(r[k]) >= v), b),
        order: (k: string, o: { ascending: boolean }) => ((ordnung = { k, auf: o.ascending }), b),
        limit: (n: number) => ((grenze = n), b),
        maybeSingle: async () => {
          const e = ergebnis();
          return { data: e.data?.[0] ?? null, error: e.error };
        },
        then: (ok: (v: unknown) => unknown, nein?: (e: unknown) => unknown) => Promise.resolve(ergebnis()).then(ok, nein),
      };
      return b;
    },
  }),
}));

import { GET, POST } from "@/app/api/ki/sicherheit/route";

const TOKEN = "s".repeat(40);
const RUN = "747b1f8d-37d8-49b0-a148-566c9339d3ed";
const ALT = "682c6014-1014-47d6-80bc-d4967f11ccb2";

const KRITISCH: BefundRoh = {
  severity: "critical",
  category: "anon-read",
  title: "View „vertrieb_counts\" ist ohne Login lesbar",
  detail: { name: "vertrieb_counts", kind: "VIEW", anon_rows: 3 },
};
const ROLLE: BefundRoh = {
  severity: "info",
  category: "rollen",
  title: "Rolle geändert · Max Muster",
  detail: { actor_label: "Leo", target_profile_label: "Max Muster" },
};

function anfrage(methode: "GET" | "POST", body?: unknown, auth = `Bearer ${TOKEN}`) {
  return new Request("http://localhost/api/ki/sicherheit", {
    method: methode,
    headers: { "content-type": "application/json", authorization: auth },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

function lauf(over: Zeile = {}): Zeile {
  return {
    id: RUN,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date().toISOString(),
    ok: true,
    critical: 0,
    warnings: 0,
    checks: 112,
    narrative: null,
    source: "cron",
    ...over,
  };
}

describe("pruefeRapport", () => {
  const z = { critical: 1, warnings: 0, checks: 112 };
  it("nimmt den deterministischen Satz an", () => {
    expect(pruefeRapport("Alles unauffällig: 112 Prüfungen, keine Befunde.", { critical: 0, warnings: 0, checks: 112 }, [])).toBeNull();
    expect(pruefeRapport("⚠ 1 kritischer Befund bei 112 Prüfungen. Die Ansicht vertrieb_counts war ohne Anmeldung lesbar.", z, [KRITISCH])).toBeNull();
  });
  it("lehnt erfundene Zahlen ab", () => {
    expect(pruefeRapport("⚠ 2 kritische Befunde bei 112 Prüfungen.", z, [KRITISCH])).toBe("Zahl passt nicht zum Lauf");
    expect(pruefeRapport("⚠ 1 kritischer Befund bei 112 Prüfungen, 37 Zeilen offen.", z, [KRITISCH])).toBe("Zahl passt nicht zum Lauf");
  });
  it("Ziffern aus Titeln sind erlaubt", () => {
    const b: BefundRoh = { ...KRITISCH, title: "Tabelle „v2_leads\" ist ohne Login lesbar", detail: { name: "v2_leads" } };
    expect(pruefeRapport("⚠ 1 kritischer Befund bei 112 Prüfungen: v2_leads war offen.", z, [b])).toBeNull();
  });
  it("verlangt Prüfungen und bei kritischen Befunden «kritisch» + Anzahl", () => {
    expect(pruefeRapport("Alles unauffällig, keine Befunde.", { critical: 0, warnings: 0, checks: 112 }, [])).toBe("Anzahl Prüfungen fehlt");
    expect(pruefeRapport("Alles unauffällig: 112 Prüfungen.", z, [KRITISCH])).toBe("kritische Befunde nicht genannt");
    expect(pruefeRapport("Ein kritischer Befund bei 112 Prüfungen.", z, [KRITISCH])).toBe("kritische Befunde nicht genannt");
  });
  it("Länge", () => {
    expect(pruefeRapport("112", { critical: 0, warnings: 0, checks: 112 }, [])).toBe("zu kurz");
  });
});

describe("saeubereRapport / leseRapportBody", () => {
  it("entfernt Markdown/Steuerzeichen, ß → ss, behält Namen mit _", () => {
    expect(saeubereRapport("**Achtung**\u0000 Die  Strasse​\nist gross: vertrieb_counts")).toBe("Achtung Die Strasse ist gross: vertrieb_counts");
    expect(saeubereRapport("Grüße")).toBe("Grüsse");
  });
  it("kappt an einer Satzgrenze", () => {
    const t = saeubereRapport(`${"Ein Satz. ".repeat(80)}`);
    expect(t.length).toBeLessThanOrEqual(RAPPORT_MAX);
    expect(t.endsWith(".")).toBe(true);
  });
  it("prüft die Form", () => {
    expect(leseRapportBody({ run_id: "x", text: "a" }).ok).toBe(false);
    expect(leseRapportBody({ run_id: RUN, text: 5 }).ok).toBe(false);
    expect(leseRapportBody({ run_id: RUN, text: "x".repeat(RAPPORT_MAX * 2 + 1) }).ok).toBe(false);
    expect(leseRapportBody([]).ok).toBe(false);
    expect(leseRapportBody({ run_id: RUN.toUpperCase(), text: " Hallo 112 " })).toEqual({ ok: true, wert: { run_id: RUN, text: "Hallo 112" } });
  });
});

describe("laufFuersRig", () => {
  it("nur Metadaten: Info-Befunde gezählt, detail gefiltert, kritisch zuerst", () => {
    const warn: BefundRoh = { severity: "warn", category: "headers", title: "Sicherheits-Header fehlen: x-frame-options", detail: { missing: ["x-frame-options"] } };
    const r = laufFuersRig(lauf({ critical: 1, warnings: 1 }) as never, [warn, ROLLE, KRITISCH]);
    expect(r.hinweise).toEqual({ rollen: 1 });
    expect(r.befunde.map((b) => b.severity)).toEqual(["critical", "warn"]);
    expect(r.befunde[0].detail).toEqual({ name: "vertrieb_counts", kind: "VIEW" });
    expect(JSON.stringify(r)).not.toContain("Max Muster");
    expect(JSON.stringify(r)).not.toContain("anon_rows");
  });
  it("kappt die Anzahl Befunde", () => {
    const viele = Array.from({ length: RAPPORT_MAX_BEFUNDE + 3 }, () => KRITISCH);
    const r = laufFuersRig(lauf() as never, viele);
    expect(r.befunde).toHaveLength(RAPPORT_MAX_BEFUNDE);
    expect(r.weitere).toBe(3);
  });
});

describe("Route /api/ki/sicherheit", () => {
  beforeEach(() => {
    vi.stubEnv("KI_SYNC_TOKEN", TOKEN);
    db.fehler = null;
    db.tabellen = {
      security_runs: [
        lauf({ id: ALT, started_at: new Date(Date.now() - 3_600_000).toISOString() }),
        lauf({ critical: 1, ok: false }),
        lauf({ id: "00000000-0000-4000-8000-000000000001", finished_at: null, started_at: new Date().toISOString() }),
        lauf({ id: "00000000-0000-4000-8000-000000000002", started_at: new Date(Date.now() - 9 * 86_400_000).toISOString() }),
      ],
      security_findings: [{ ...KRITISCH, run_id: RUN, occurred_at: "1" }, { ...ROLLE, run_id: RUN, occurred_at: "2" }],
    };
  });
  afterEach(() => vi.unstubAllEnvs());

  it("Auth: falsches Token 401, ohne Secret 503", async () => {
    expect((await GET(anfrage("GET", undefined, "Bearer falsch"))).status).toBe(401);
    vi.stubEnv("KI_SYNC_TOKEN", "");
    expect((await GET(anfrage("GET"))).status).toBe(503);
  });

  it("GET: neuester fertige Lauf ohne narrative (nicht unfertig, nicht älter als 7 Tage)", async () => {
    const r = await GET(anfrage("GET"));
    const j = await r.json();
    expect(j.lauf.id).toBe(RUN);
    expect(j.lauf.befunde).toHaveLength(1);
    expect(j.lauf.hinweise).toEqual({ rollen: 1 });
  });

  it("GET: Tabelle fehlt → lauf null", async () => {
    db.fehler = { code: "PGRST205" };
    const j = await (await GET(anfrage("GET"))).json();
    expect(j).toEqual({ success: true, lauf: null });
  });

  it("POST: setzt narrative genau einmal", async () => {
    const text = "⚠ 1 kritischer Befund bei 112 Prüfungen. Die Ansicht vertrieb_counts war ohne Anmeldung lesbar.";
    const r = await POST(anfrage("POST", { run_id: RUN, text }));
    expect(r.status).toBe(200);
    expect(db.tabellen.security_runs.find((z) => z.id === RUN)?.narrative).toBe(text);
    expect(db.tabellen.security_runs.find((z) => z.id === ALT)?.narrative).toBeNull();
    expect((await POST(anfrage("POST", { run_id: RUN, text }))).status).toBe(409);
  });

  it("POST: Text, der nicht zum Lauf passt → 422, nichts geschrieben", async () => {
    const r = await POST(anfrage("POST", { run_id: RUN, text: "Alles unauffällig: 112 Prüfungen, keine Befunde." }));
    expect(r.status).toBe(422);
    expect(db.tabellen.security_runs.find((z) => z.id === RUN)?.narrative).toBeNull();
  });

  it("POST: unbekannt 404, unfertig 409, Form 400", async () => {
    expect((await POST(anfrage("POST", { run_id: "00000000-0000-4000-8000-0000000000ff", text: "112 Prüfungen ok" }))).status).toBe(404);
    expect((await POST(anfrage("POST", { run_id: "00000000-0000-4000-8000-000000000001", text: "112 Prüfungen ok" }))).status).toBe(409);
    expect((await POST(anfrage("POST", "kein json"))).status).toBe(400);
    expect((await POST(anfrage("POST", { run_id: RUN }))).status).toBe(400);
  });
});
