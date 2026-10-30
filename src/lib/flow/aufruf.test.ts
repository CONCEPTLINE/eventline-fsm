// Ablauf eines Aufrufs aus Trust flow: 503 ohne Schlüssel, Wartung, Einmal-Schutz
// (jti), Höchstzahl je Minute, Protokoll vor der Antwort. Datenbank als Attrappe
// mit denselben Regeln wie flow_abruf_beginnen (Migration 369).
import { describe, expect, it } from "vitest";
import { bearbeiteFlowAufruf, type Abschluss, type BeginnDaten, type BeginnErgebnis, type FlowSpeicher } from "./aufruf";
import { pruefeMonatsClaims, pruefeStammdatenClaims, sha256Hex } from "./regeln";
import { claims, signiere, testSchluessel } from "./test-hilfen";
import type { FlowAud } from "./ausweis";

const k = testSchluessel();

/** Attrappe der Datenbank: jti einmalig, 10 (abruf) bzw. 30 (ablage) je 60 s. */
function speicher(opts: { wartung?: boolean; uhr: { t: number } }) {
  const zeilen: { id: string; d: BeginnDaten; status: string; zeit: number; abschluss?: Abschluss }[] = [];
  const s: FlowSpeicher = {
    async wartungAktiv() {
      return opts.wartung === true;
    },
    async beginne(d): Promise<BeginnErgebnis> {
      const gruppe = (a: FlowAud) => (a === "erp-lohnabrechnung-ablage" ? "ablage" : "abruf");
      const zaehlt = (z: (typeof zeilen)[number]) => z.status !== "wiederholt" && z.status !== "zu_viele";
      if (zeilen.some((z) => zaehlt(z) && z.d.jti === d.jti)) {
        zeilen.push({ id: `w${zeilen.length}`, d, status: "wiederholt", zeit: opts.uhr.t });
        return { status: "wiederholt" };
      }
      const limit = gruppe(d.aud) === "ablage" ? 30 : 10;
      const imFenster = zeilen.filter((z) => zaehlt(z) && gruppe(z.d.aud) === gruppe(d.aud) && z.zeit > opts.uhr.t - 60);
      if (imFenster.length >= limit) {
        zeilen.push({ id: `z${zeilen.length}`, d, status: "zu_viele", zeit: opts.uhr.t });
        return { status: "zu_viele", retryAfter: Math.max(1, Math.ceil(Math.min(...imFenster.map((z) => z.zeit)) + 60 - opts.uhr.t)) };
      }
      const id = `id${zeilen.length}`;
      zeilen.push({ id, d, status: "angenommen", zeit: opts.uhr.t });
      return { status: "ok", id };
    },
    async schliesse(id, a) {
      const z = zeilen.find((x) => x.id === id && x.status === "angenommen");
      if (!z) throw new Error("läuft nicht");
      z.status = a.status;
      z.abschluss = a;
    },
  };
  return { s, zeilen };
}

function aufruf(o: {
  token: string;
  uhr: { t: number };
  sp: FlowSpeicher;
  aud?: FlowAud;
  schluessel?: string | undefined;
  ausfuehren?: () => Promise<{ ok: true; body: unknown; geliefert: number }>;
}) {
  return bearbeiteFlowAufruf({
    aud: o.aud ?? "erp-stempel",
    token: o.token,
    schluesselWert: "schluessel" in o ? o.schluessel : k.oeffentlichB64,
    speicher: o.sp,
    jetztSek: o.uhr.t,
    pruefe: (a) => pruefeMonatsClaims(a.claims, { bereich: true }),
    ausfuehren: o.ausfuehren ?? (async () => ({ ok: true, body: { monat_gesperrt: true, personen: [], nachtraeglich_geaendert: [] }, geliefert: 0 })),
  });
}

describe("Aufruf aus Trust flow", () => {
  it("ohne FLOW_ABRUF_PUBLIC_KEY → 503, nichts protokolliert (nie offen)", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    const r = await aufruf({ token: signiere(k.privat, claims("erp-stempel", uhr.t)), uhr, sp: s, schluessel: undefined });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).code).toBe("nicht_eingerichtet");
    expect(zeilen).toHaveLength(0);
  });

  it("gültig → 200, Protokoll «ok» mit Anzahl Personen und sha256 der Antwort", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    const body = { monat_gesperrt: false, personen: [{ erp_profil_id: "x" }], nachtraeglich_geaendert: [] };
    const r = await aufruf({ token: signiere(k.privat, claims("erp-stempel", uhr.t)), uhr, sp: s, ausfuehren: async () => ({ ok: true, body, geliefert: 1 }) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(body);
    expect(r.headers["Cache-Control"]).toBe("no-store");
    expect(zeilen[0].status).toBe("ok");
    expect(zeilen[0].abschluss).toEqual({ status: "ok", geliefert: 1, sha256: sha256Hex(r.body), grund: null });
    expect(zeilen[0].d).toMatchObject({ aud: "erp-stempel", jahr: 2026, monat: 12, angefragt: 2 });
  });

  it("wiederverwendeter jti → 409, die Daten werden nicht nochmals geliefert", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    const t = signiere(k.privat, claims("erp-stempel", uhr.t));
    expect((await aufruf({ token: t, uhr, sp: s })).status).toBe(200);
    uhr.t += 2;
    const zwei = await aufruf({ token: t, uhr, sp: s });
    expect(zwei.status).toBe(409);
    expect(JSON.parse(zwei.body).code).toBe("ausweis_verwendet");
    expect(zeilen.map((z) => z.status)).toEqual(["ok", "wiederholt"]);
  });

  it("abgelaufener Ausweis, falscher aud, falscher Schlüssel → 401 ohne Details, nichts in der Datenbank", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    const alt = signiere(k.privat, claims("erp-stempel", uhr.t - 120));
    const fremd = signiere(testSchluessel().privat, claims("erp-stempel", uhr.t));
    const aud = signiere(k.privat, claims("erp-vergleich", uhr.t));
    for (const token of [alt, fremd, aud]) {
      const r = await aufruf({ token, uhr, sp: s });
      expect(r.status).toBe(401);
      expect(JSON.parse(r.body)).toEqual({ success: false, code: "ausweis_ungueltig", error: "Ausweis ungültig." });
    }
    expect(zeilen).toHaveLength(0);
  });

  it("Höchstzahl: 10 Abrufe je Minute, der 11. → 429 mit Retry-After; nach Ablauf wieder frei", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    for (let i = 0; i < 10; i++) {
      expect((await aufruf({ token: signiere(k.privat, claims("erp-stempel", uhr.t)), uhr, sp: s })).status).toBe(200);
      uhr.t += 1;
    }
    const elf = await aufruf({ token: signiere(k.privat, claims("erp-personen", uhr.t)), uhr, sp: s, aud: "erp-personen" });
    expect(elf.status).toBe(429);
    expect(Number(elf.headers["Retry-After"])).toBe(50);
    // Die Ablage (Lohnabrechnungen) hat ein eigenes Kontingent.
    const ablage = await bearbeiteFlowAufruf({
      aud: "erp-lohnabrechnung-ablage", token: signiere(k.privat, claims("erp-lohnabrechnung-ablage", uhr.t)), schluesselWert: k.oeffentlichB64,
      speicher: s, jetztSek: uhr.t, pruefe: () => ({ ok: true, anfrage: null }), ausfuehren: async () => ({ ok: true, body: { ok: true }, geliefert: 1 }),
    });
    expect(ablage.status).toBe(200);
    uhr.t += 51;
    expect((await aufruf({ token: signiere(k.privat, claims("erp-stempel", uhr.t)), uhr, sp: s })).status).toBe(200);
    expect(zeilen.filter((z) => z.status === "zu_viele")).toHaveLength(1);
  });

  it("Wartung «lohn» → 503 mit Hinweis, Ausweis bleibt unverbraucht", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr, wartung: true });
    const r = await aufruf({ token: signiere(k.privat, claims("erp-stempel", uhr.t)), uhr, sp: s });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toMatchObject({ code: "wartung", bereich: "lohn" });
    expect(JSON.parse(r.body).error).toMatch(/Umbauten/);
    expect(zeilen).toHaveLength(0);
  });

  it("Claims der Route ungültig → 400, im Protokoll «abgelehnt» (jti verbraucht)", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    const r = await aufruf({ token: signiere(k.privat, claims("erp-stempel", uhr.t, { von: "2026-01-01" })), uhr, sp: s });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).code).toBe("bereich_abweichend");
    expect(zeilen[0].status).toBe("abgelehnt");
    expect(zeilen[0].abschluss?.grund).toBe("bereich_abweichend");
  });

  it("Fehler beim Ausführen → 500 ohne Details, Protokoll «fehler»", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    const r = await aufruf({
      token: signiere(k.privat, claims("erp-stempel", uhr.t)), uhr, sp: s,
      ausfuehren: async () => { throw new Error("DB weg"); },
    });
    expect(r.status).toBe(500);
    expect(r.body).not.toMatch(/DB weg/);
    expect(zeilen[0].status).toBe("fehler");
  });
});

describe("Stammdaten (A6) im gleichen Ablauf", () => {
  const stamm = (sp: FlowSpeicher, uhr: { t: number }, token: string) =>
    bearbeiteFlowAufruf({
      aud: "flow-stammdaten", token, schluesselWert: k.oeffentlichB64, speicher: sp, jetztSek: uhr.t,
      pruefe: (a) => pruefeStammdatenClaims(a.claims),
      ausfuehren: async (anfrage) => ({ ok: true, body: { personen: anfrage.profile.map((id) => ({ erp_profil_id: id })) }, geliefert: anfrage.profile.length }),
    });

  it("gültig → 200; Protokoll ohne Monat (jahr/monat im Ausweis werden ignoriert), angefragt = Anzahl Profile", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    const r = await stamm(s, uhr, signiere(k.privat, claims("flow-stammdaten", uhr.t)));
    expect(r.status).toBe(200);
    expect(r.headers["X-Antwort-Sha256"]).toBe(sha256Hex(r.body));
    expect(zeilen[0].d).toMatchObject({ aud: "flow-stammdaten", jahr: null, monat: null, angefragt: 2 });
    expect(zeilen[0].abschluss).toMatchObject({ status: "ok", geliefert: 2 });
    // derselbe Ausweis nochmals → 409
    const t = signiere(k.privat, claims("flow-stammdaten", uhr.t));
    expect((await stamm(s, uhr, t)).status).toBe(200);
    expect(JSON.parse((await stamm(s, uhr, t)).body).code).toBe("ausweis_verwendet");
  });

  it("zählt zur Gruppe «Abruf»: 10 Stempel-Abrufe füllen die Minute, Stammdaten → 429", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s } = speicher({ uhr });
    for (let i = 0; i < 10; i++) expect((await aufruf({ token: signiere(k.privat, claims("erp-stempel", uhr.t)), uhr, sp: s })).status).toBe(200);
    const r = await stamm(s, uhr, signiere(k.privat, claims("flow-stammdaten", uhr.t)));
    expect(r.status).toBe(429);
    expect(JSON.parse(r.body).code).toBe("zu_viele");
  });

  it("über 50 Profile → 400 profile_zu_viele, im Protokoll «abgelehnt»", async () => {
    const uhr = { t: 1_800_000_000 };
    const { s, zeilen } = speicher({ uhr });
    const viele = Array.from({ length: 51 }, (_, i) => `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const r = await stamm(s, uhr, signiere(k.privat, claims("flow-stammdaten", uhr.t, { profile: viele })));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).code).toBe("profile_zu_viele");
    expect(zeilen[0]).toMatchObject({ status: "abgelehnt" });
  });
});
