// Leistung der lokalen KI (VERTRAG §2.6, §6.5): Lesen der DB-Antwort, Zusammensetzen je Zeitraum und die Route
// GET /api/technik/leistung (Anmeldung, Zeitraum, nur Zahlen) mit Attrappen (keine echte DB).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { baueLeistung, istLeistungZeitraum, leseFsmLeistung, zeitraumVon } from "./leistung";
import type { LeistungRig } from "./typen";

const zustand = vi.hoisted(() => ({
  user: null as null | { id: string },
  rolle: "mitarbeiter",
  rigWerte: null as unknown,
  rpc: [] as Array<{ name: string; p: unknown }>,
  rpcAntwort: null as unknown,
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
vi.mock("next/cache", () => ({ unstable_cache: <T extends (...a: never[]) => unknown>(fn: T) => fn }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => ({
      select: (spalten: string) => ({
        eq: (k: string, v: unknown) => ({
          maybeSingle: async () => {
            expect(t).toBe("technik_stand");
            expect(spalten).toBe("leistung:werte->leistung");
            expect([k, v]).toEqual(["quelle", "rig"]);
            return { data: zustand.rigWerte === null ? null : { leistung: zustand.rigWerte }, error: null };
          },
        }),
      }),
    }),
    rpc: async (name: string, p: unknown) => {
      zustand.rpc.push({ name, p });
      return { data: zustand.rpcAntwort, error: null };
    },
  }),
}));

import { GET } from "@/app/api/technik/leistung/route";

const JETZT = new Date("2026-10-15T15:20:00Z");

const DB_ANTWORT = {
  ablage: [
    { logik: "lokal", seit: "2026-10-12T17:17:42.245765+00:00", vorschlaege: 196, offen: 196, unveraendert: 0, geaendert: 0, ordner_geaendert: 0, name_geaendert: 0, abgelehnt: 0, entscheid_von: null, entscheid_bis: null, pfad: "02_LOCATIONS/geheim.pdf" },
    { logik: "claude", seit: "2026-10-15T12:48:58.652178+00:00", vorschlaege: 86, offen: 80, unveraendert: 4, geaendert: "2", ordner_geaendert: 1, name_geaendert: 1, abgelehnt: 0, entscheid_von: "2026-10-15T13:00:00+00:00", entscheid_bis: "2026-10-15T14:00:00+00:00" },
    { logik: "fremd", seit: null, vorschlaege: 9 },
  ],
  uploads: { seit: "2026-10-15T16:00:00+00:00", mit_vorschlag: 6, unveraendert: 3, ordner_geaendert: 2, name_geaendert: "2",
             regel: 1, lokal: 2, claude: 2, beschrieb: 9, ordner: "06_PERSONAL/geheim" },
  groesstes: { seiten: 22, herkunft: "zz", am: "2026-10-15T17:00:00+00:00", pfad: "ZZ/geheim.pdf" },
  fristen: { seit: "2026-10-12T17:03:45.803437+00:00", gefunden: 5, bestaetigt: 0, verworfen: 0, offen: 5 },
  sicherheit: { seit: "2026-10-15T08:08:14.935187+00:00", rapporte: 3 },
};

const RIG: LeistungRig = {
  stand: "2026-10-15T15:10:00.000Z",
  seit: "2026-10-02T20:50:00.000Z",
  zeitraeume: {
    "7d": { auftraege: [{ art: "nas_suche", n: 41, ok: 41, median_ms: 59, max_ms: 6235 }], gelesen: { dateien: 449, seiten: 668 } },
    alle: { auftraege: [{ art: "nas_suche", n: 41, ok: 41, median_ms: 59, max_ms: 6235 }, { art: "diktat", n: 4, ok: 4, median_ms: 4066 }] },
  },
  selbsttest: [
    { am: "2026-10-15T03:37:46.000Z", dateien: 40, top1: 0.45, top3: 0.65 },
    { am: "2026-10-14T03:38:27.000Z", dateien: 40, top1: 0.55, top3: 0.65 },
    { am: "2026-09-20T03:40:00.000Z", dateien: 40, top1: 0.5, top3: 0.7 },
  ],
};

describe("leseFsmLeistung", () => {
  it("nimmt nur bekannte Logiken und Zahlen, neueste Logik zuerst, keine Pfade", () => {
    const f = leseFsmLeistung(DB_ANTWORT);
    expect(f.ablage.map((a) => a.logik)).toEqual(["claude", "lokal"]);
    expect(f.ablage[0]).toEqual({
      logik: "claude", seit: "2026-10-15T12:48:58.652Z", vorschlaege: 86, offen: 80, unveraendert: 4, geaendert: 2,
      ordner_geaendert: 1, name_geaendert: 1, abgelehnt: 0, entscheid_von: "2026-10-15T13:00:00.000Z", entscheid_bis: "2026-10-15T14:00:00.000Z",
    });
    expect(JSON.stringify(f)).not.toContain("geheim");
    expect(f.fristen).toEqual({ seit: "2026-10-12T17:03:45.803Z", gefunden: 5, bestaetigt: 0, verworfen: 0, offen: 5 });
    expect(f.sicherheit).toEqual({ seit: "2026-10-15T08:08:14.935Z", rapporte: 3 });
  });

  it("Ablagen aus der App: Teilmengen hoechstens die Zahl mit Vorschlag; groesstes nur mit Seiten, Herkunft, Zeit", () => {
    const f = leseFsmLeistung(DB_ANTWORT);
    expect(f.uploads).toEqual({
      seit: "2026-10-15T16:00:00.000Z", mit_vorschlag: 6, unveraendert: 3, ordner_geaendert: 2, name_geaendert: 2,
      quellen: { regel: 1, lokal: 2, claude: 2, beschrieb: 6 },
    });
    expect(f.groesstes).toEqual({ seiten: 22, herkunft: "zz", am: "2026-10-15T17:00:00.000Z" });
    expect(leseFsmLeistung({ ...DB_ANTWORT, groesstes: { seiten: 0, herkunft: "zz", am: "2026-10-15T17:00:00Z" } }).groesstes).toBeNull();
    expect(leseFsmLeistung({ ...DB_ANTWORT, groesstes: { seiten: 3, herkunft: "nas", am: "2026-10-15T17:00:00Z" } }).groesstes).toBeNull();
    expect(leseFsmLeistung({ ...DB_ANTWORT, groesstes: null }).groesstes).toBeNull();
  });

  it("kaputte oder leere Antwort ergibt Nullen statt eines Fehlers", () => {
    expect(leseFsmLeistung(null)).toEqual({
      ablage: [],
      uploads: { seit: null, mit_vorschlag: 0, unveraendert: 0, ordner_geaendert: 0, name_geaendert: 0, quellen: { regel: 0, lokal: 0, claude: 0, beschrieb: 0 } },
      groesstes: null,
      fristen: { seit: null, gefunden: 0, bestaetigt: 0, verworfen: 0, offen: 0 },
      sicherheit: { seit: null, rapporte: 0 },
    });
    expect(leseFsmLeistung({ ablage: "x", fristen: { gefunden: -3 } }).fristen.gefunden).toBe(0);
  });
});

describe("baueLeistung", () => {
  const fsm = leseFsmLeistung(DB_ANTWORT);

  it("waehlt den Block des Zeitraums und die Selbsttest-Laeufe im Zeitraum", () => {
    const l = baueLeistung({ rig: RIG, fsm, zeitraum: "7d", jetzt: JETZT });
    expect(l).toMatchObject({ success: true, zeitraum: "7d", von: "2026-10-08T15:20:00.000Z", jetzt: JETZT.toISOString() });
    expect(l.rig?.block?.gelesen?.dateien).toBe(449);
    expect(l.rig?.selbsttest.map((x) => x.am)).toEqual(["2026-10-15T03:37:46.000Z", "2026-10-14T03:38:27.000Z"]);
    expect(l.ablage).toBe(fsm.ablage);
  });

  it("gesamt: alle Laeufe; fehlt der Zeitraum beim Rig, ist der Block null; ohne Rig ist rig null", () => {
    expect(baueLeistung({ rig: RIG, fsm, zeitraum: "alle", jetzt: JETZT }).rig?.selbsttest).toHaveLength(3);
    expect(baueLeistung({ rig: RIG, fsm, zeitraum: "30d", jetzt: JETZT }).rig?.block).toBeNull();
    expect(baueLeistung({ rig: null, fsm, zeitraum: "30d", jetzt: JETZT }).rig).toBeNull();
  });

  it("Zeitraeume", () => {
    expect(zeitraumVon("30d", JETZT)).toBe("2026-09-15T15:20:00.000Z");
    expect(zeitraumVon("alle", JETZT)).toBeNull();
    expect(istLeistungZeitraum("7d")).toBe(true);
    expect(istLeistungZeitraum("1y")).toBe(false);
  });
});

describe("GET /api/technik/leistung", () => {
  const req = (q = "") => new Request(`http://localhost/api/technik/leistung${q}`);
  beforeEach(() => {
    zustand.rpc = [];
    zustand.rigWerte = RIG;
    zustand.rpcAntwort = DB_ANTWORT;
  });

  it("401 ohne Anmeldung, 403 fuer Nicht-Admins — nichts gelesen", async () => {
    zustand.user = null;
    expect((await GET(req())).status).toBe(401);
    zustand.user = { id: "u1" };
    zustand.rolle = "mitarbeiter";
    expect((await GET(req())).status).toBe(403);
    expect(zustand.rpc).toEqual([]);
  });

  it("200 fuer Admins ohne Cache; Zeitraum aus der Anfrage, sonst 30 Tage", async () => {
    zustand.user = { id: "u1" };
    zustand.rolle = "admin";
    const r = await GET(req("?zeitraum=7d"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = await r.json();
    expect(j).toMatchObject({ success: true, zeitraum: "7d", rig: { stand: RIG.stand, seit: RIG.seit } });
    expect(zustand.rpc).toHaveLength(1);
    expect(zustand.rpc[0].name).toBe("technik_leistung");
    expect(typeof (zustand.rpc[0].p as { p_von: unknown }).p_von).toBe("string");

    const d = await (await GET(req("?zeitraum=1y"))).json();
    expect(d.zeitraum).toBe("30d");
    await GET(req("?zeitraum=alle"));
    expect(zustand.rpc.at(-1)?.p).toEqual({ p_von: null });
  });

  it("ohne Leistung vom Rig: rig null, FSM-Zahlen trotzdem", async () => {
    zustand.user = { id: "u1" };
    zustand.rolle = "admin";
    zustand.rigWerte = { zeitraeume: {} }; // ohne Stand = unbrauchbar
    const j = await (await GET(req())).json();
    expect(j.rig).toBeNull();
    expect(j.fristen.gefunden).toBe(5);
  });
});
