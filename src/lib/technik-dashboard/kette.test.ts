// Kette Rig → FSM → Seite mit einem ECHTEN Paket vom Rig (12.10.2026, nur Zahlen, Zustandswoerter und
// Software-Namen): POST /api/technik/messwerte speichert in eine In-Memory-Datenbank, danach liefert
// ladeTechnikStand (= GET /api/technik/stand) daraus die Antwort, die die Seite liest.
// Prueft die Vertragsnaht (VERTRAG.md §2–§6): Felder, Ampel-Schluessel, Reihen-Format, Datenschutz.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import echtesPaket from "./testdaten/rig-paket-2026-10-12.json";

type Zeile = Record<string, unknown>;
const db = vi.hoisted(() => ({ tabellen: {} as Record<string, Zeile[]> }));

/** Kleiner PostgREST-Nachbau: select/eq/gte/lte/order/limit/maybeSingle, count+head, insert, upsert, rpc. */
function vergleich(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    const da = Date.parse(a), dbb = Date.parse(b);
    if (!Number.isNaN(da) && !Number.isNaN(dbb) && /\d{4}-\d{2}-\d{2}T/.test(a)) return da - dbb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return Number(a) - Number(b);
}
class Abfrage {
  private filter: Array<(z: Zeile) => boolean> = [];
  private sortierung: { k: string; auf: boolean } | null = null;
  private grenze: number | null = null;
  private einzeln = false;
  private kopf = false;
  private zaehlen = false;
  constructor(private tab: string) {}
  select(_spalten?: string, opts?: { count?: string; head?: boolean }) {
    this.kopf = !!opts?.head;
    this.zaehlen = !!opts?.count;
    return this;
  }
  eq(k: string, v: unknown) { this.filter.push((z) => z[k] === v); return this; }
  gte(k: string, v: unknown) { this.filter.push((z) => z[k] != null && vergleich(z[k], v) >= 0); return this; }
  lte(k: string, v: unknown) { this.filter.push((z) => z[k] != null && vergleich(z[k], v) <= 0); return this; }
  order(k: string, o?: { ascending?: boolean }) { this.sortierung = { k, auf: o?.ascending !== false }; return this; }
  limit(n: number) { this.grenze = n; return this; }
  maybeSingle() { this.einzeln = true; return this; }
  private ergebnis() {
    let zeilen = (db.tabellen[this.tab] ?? []).filter((z) => this.filter.every((f) => f(z)));
    if (this.sortierung) {
      const { k, auf } = this.sortierung;
      zeilen = [...zeilen].sort((a, b) => (auf ? 1 : -1) * vergleich(a[k], b[k]));
    }
    const anzahl = zeilen.length;
    if (this.grenze != null) zeilen = zeilen.slice(0, this.grenze);
    const kopie = zeilen.map((z) => structuredClone(z));
    if (this.einzeln) return { data: kopie[0] ?? null, error: null, count: null };
    return { data: this.kopf ? null : kopie, error: null, count: this.zaehlen ? anzahl : null };
  }
  then<T>(ok: (r: ReturnType<Abfrage["ergebnis"]>) => T, fehler?: (e: unknown) => T) {
    try {
      return Promise.resolve(ok(this.ergebnis()));
    } catch (e) {
      return fehler ? Promise.resolve(fehler(e)) : Promise.reject(e);
    }
  }
}
function tabelle(t: string) {
  db.tabellen[t] ??= [];
  return db.tabellen[t];
}
/** technik_reihe fuer Schritte < 1 h, wie die SQL-Funktion in 313 (Minuten-Buckets, Spitze aus «.max»). */
function technikReihe(p: { p_quelle: string; p_von: string; p_bis: string; p_schritt_s: number; p_schluessel: string[] }) {
  const schritt = Math.max(60, p.p_schritt_s) * 1000;
  const buckets = new Map<string, { t: number; s: string; summe: number; n: number; spitze: number | null }>();
  for (const m of tabelle("technik_messwerte")) {
    const ms = Date.parse(m.minute as string);
    if (m.quelle !== p.p_quelle || ms < Date.parse(p.p_von) || ms >= Date.parse(p.p_bis)) continue;
    const werte = m.werte as Record<string, number>;
    for (const s of p.p_schluessel) {
      if (!(s in werte) && !(`${s}.max` in werte)) continue;
      const t = Math.floor(ms / schritt) * schritt;
      const b = buckets.get(`${t}|${s}`) ?? { t, s, summe: 0, n: 0, spitze: null };
      if (typeof werte[s] === "number") { b.summe += werte[s]; b.n += 1; }
      const sp = typeof werte[`${s}.max`] === "number" ? werte[`${s}.max`] : werte[s];
      if (typeof sp === "number") b.spitze = b.spitze == null ? sp : Math.max(b.spitze, sp);
      buckets.set(`${t}|${s}`, b);
    }
  }
  return [...buckets.values()].map((b) => ({
    t: new Date(b.t).toISOString().replace(".000Z", "+00:00"), // wie PostgREST timestamptz liefert
    schluessel: b.s,
    mittel: b.n ? b.summe / b.n : null,
    spitze: b.spitze,
  }));
}
const fakeClient = {
  from: (t: string) => ({
    select: (s?: string, o?: { count?: string; head?: boolean }) => new Abfrage(t).select(s, o),
    insert: (rows: Zeile[]) => { tabelle(t).push(...rows.map((r) => ({ id: crypto.randomUUID(), zeitpunkt: new Date().toISOString(), ...r }))); return Promise.resolve({ error: null }); },
    upsert: (rows: Zeile[], o: { onConflict: string }) => {
      const tab = tabelle(t);
      const keys = o.onConflict.split(",");
      for (const row of rows) {
        const i = tab.findIndex((r) => keys.every((k) => r[k] === row[k]));
        if (i >= 0) tab[i] = structuredClone(row);
        else tab.push(structuredClone(row));
      }
      return Promise.resolve({ error: null });
    },
  }),
  rpc: (name: string, p: Parameters<typeof technikReihe>[0]) =>
    Promise.resolve(name === "technik_reihe" ? { data: technikReihe(p), error: null } : { data: null, error: { message: "unbekannt" } }),
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient }));
vi.mock("@/lib/log", () => ({ logError: vi.fn() }));
vi.mock("@/lib/notification-service", () => ({ notifyTechnikAlarm: vi.fn(), notifyTechnikEntwarnung: vi.fn() }));

import { POST } from "@/app/api/technik/messwerte/route";
import { ladeTechnikStand } from "./stand-server";
import { alarmLauf } from "./alarme";
import { DIENST_NAMEN, MINUTEN_SCHLUESSEL, REIHEN_SCHLUESSEL } from "./konstanten";
import type { Bauteil, Kachel, NeutralArt, Stufe, TechnikStand } from "./typen";

const TOKEN = "k".repeat(40);
const SENDEZEIT = Date.parse(echtesPaket.gesendet_am);

/** Das echte Paket um `ms` verschoben (alle Zeitstempel), wie es eine Minute spaeter kaeme. */
function verschoben(ms: number) {
  const text = JSON.stringify(echtesPaket).replace(/"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"/g, (_, iso: string) => {
    const neu = new Date(Date.parse(iso) + ms).toISOString().replace(".000Z", "Z");
    return `"${neu}"`;
  });
  const p = JSON.parse(text) as typeof echtesPaket;
  // Laufzeit, Zaehler und Startzeiten der Dienste bleiben echt (kein Neustart)
  p.rig.uptime_s = echtesPaket.rig.uptime_s + Math.round(ms / 1000);
  p.rig.dienste = structuredClone(echtesPaket.rig.dienste);
  if (p.ki.archiv) p.ki.archiv.letzter_lauf = echtesPaket.ki.archiv.letzter_lauf;
  if (p.ki.tiefen_index) p.ki.tiefen_index.letzter_lauf = echtesPaket.ki.tiefen_index.letzter_lauf;
  return p;
}
function anfrage(body: unknown) {
  return new Request("http://localhost/api/technik/messwerte", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}
function iso(ms: number) {
  return new Date(ms).toISOString();
}

// Schluessel, die die Seite (components/technik-dashboard) direkt nachschlaegt
const SEITE_AMPELN = [
  "ablage.index", "ablage.sync", "backup.fsm", "cpu.last", "cpu.temp", "gpu.temp", "ki.warteschlange", "messwerte.frische",
  "nas.erreichbar", "nas.freigaben", "nas.hw.plattentemp", "nas.hw.systemtemp", "nas.hw.zugang", "nas.volume",
  "platte.system", "ram.swap", "ram.verfuegbar", "ssd.temp", "verbindung.antwortzeit", "verbindung.online",
];
const SEITE_REIHEN = [
  "cpu.temp", "cpu.last", "gpu.temp", "gpu.last", "ram.verfuegbar_gb", "ram.ki_gb", "ram.trustone_gb", "ram.swap_gb",
  "ki.warteschlange", "ki.fsm_antwort_ms", "nas.belegt_prozent",
];
const BAUTEILE: Bauteil[] = ["cpu", "gpu", "ram", "platten", "dienste", "ki", "app", "ablage", "nas", "index", "hardware", "backup"];
const KACHELN: Kachel[] = ["rig", "ki", "ram", "platten", "nas", "backup", "verbindung", "messwerte"];
const STUFEN: Stufe[] = ["gut", "warnung", "kritisch", "neutral"];
const NEUTRAL: NeutralArt[] = ["kommt", "ruht", "soll_offen", "veraltet", "info", "nie_gemeldet", "nicht_lesbar"];

describe("Kette Rig → FSM → Seite mit echtem Rig-Paket", () => {
  const alt = process.env.KI_SYNC_TOKEN;
  let stand: TechnikStand;
  let jetzt: number;

  beforeAll(async () => {
    process.env.KI_SYNC_TOKEN = TOKEN;
    db.tabellen = {};
    vi.useFakeTimers({ toFake: ["Date"] });
    // FSM-seitige Tabellen, wie sie heute in der DB stehen (Form, keine echten Inhalte)
    jetzt = SENDEZEIT + 60_000 + 5_000;
    db.tabellen.ki_status = [{ id: 1, letzter_poll: iso(jetzt - 2_000), online_seit: iso(jetzt - 3600_000), version: "0.1.0+20261012-1230", letzter_fehler: null, gpu: "KARTENNAME-DARF-NIE-RAUS" }];
    db.tabellen.ki_auftraege = [{ id: "a1", status: "fertig", created_at: iso(jetzt - 3600_000) }];
    db.tabellen.nas_backup_runs = [{ id: "b1", status: "ok", reported_at: iso(jetzt - 8 * 3600_000), total_size: "1.2 GB", db_size: "300 MB", storage_size: "900 MB" }];
    db.tabellen.nas_backup_alerts = [];
    db.tabellen.ablage_sync_status = [{ id: 1, letzter_poll: iso(jetzt - 20_000), intervall_s: 30 }];
    db.tabellen.ablage_datei_index = [{ id: "d1", aktualisiert: iso(jetzt - 5 * 60_000) }, { id: "d2", aktualisiert: iso(jetzt - 3600_000) }];
    db.tabellen.technik_zustaende = [];

    // Paket 1 (echt) und Paket 2 (eine Minute spaeter) wie der Melder sie schickt
    vi.setSystemTime(SENDEZEIT + 1_000);
    const r1 = await POST(anfrage(echtesPaket));
    expect(r1.status).toBe(200);
    vi.setSystemTime(SENDEZEIT + 61_000);
    const r2 = await POST(anfrage(verschoben(60_000)));
    expect(r2.status).toBe(200);

    vi.setSystemTime(jetzt);
    stand = await ladeTechnikStand(fakeClient as never, { bereich: "6h", reihen: true, jetzt: new Date(jetzt) });
  });
  afterAll(() => {
    vi.useRealTimers();
    process.env.KI_SYNC_TOKEN = alt;
  });
  beforeEach(() => vi.setSystemTime(jetzt));

  it("speichert alle drei Bloecke und die Minutenwerte (rig vollstaendig, ki/nas abgeleitet)", () => {
    expect(db.tabellen.technik_stand.map((z) => z.quelle).sort()).toEqual(["ki", "nas", "rig"]);
    const rigMin = db.tabellen.technik_messwerte.filter((m) => m.quelle === "rig");
    expect(rigMin).toHaveLength(2);
    // Jeder Minuten-Schluessel des Rigs ist im Vertrag bekannt — nichts faellt still weg
    const gesendet = Object.keys(echtesPaket.rig.minute);
    expect(gesendet.filter((k) => !MINUTEN_SCHLUESSEL.includes(k))).toEqual([]);
    expect(Object.keys(rigMin[0].werte as object).sort()).toEqual([...gesendet].sort());
    expect(db.tabellen.technik_messwerte.filter((m) => m.quelle === "ki")[0].werte).toMatchObject({ "ki.warteschlange": 0 });
    expect(db.tabellen.technik_messwerte.filter((m) => m.quelle === "nas")[0].werte).toHaveProperty("nas.belegt_prozent");
  });

  it("erzeugt aus zwei normalen Paketen keine Ereignisse", () => {
    expect(db.tabellen.technik_ereignisse ?? []).toEqual([]);
  });

  it("liefert eine Antwort, die zum Vertrag und zur Seite passt", () => {
    expect(stand.success).toBe(true);
    expect(stand.hat_daten).toBe(true);
    expect(stand.rig_alter_s).toBeLessThan(180);
    expect(stand.ki_alter_s).toBeLessThan(180);
    expect(stand.nas_alter_s).toBeLessThan(300);
    for (const a of stand.ampeln) {
      expect(BAUTEILE).toContain(a.bauteil);
      if (a.kachel !== null) expect(KACHELN).toContain(a.kachel);
      expect(STUFEN).toContain(a.stufe);
      if (a.stufe === "neutral") expect(NEUTRAL).toContain(a.neutral);
      else expect(a.neutral).toBeUndefined();
      expect(a.text.length).toBeGreaterThan(0);
    }
    const schluessel = new Set(stand.ampeln.map((a) => a.schluessel));
    expect(SEITE_AMPELN.filter((s) => !schluessel.has(s))).toEqual([]);
    for (const d of DIENST_NAMEN) expect(schluessel.has(`dienst.${d}`)).toBe(true);
    // Jede Kachel der Statusleiste hat mindestens eine Ampel
    for (const k of KACHELN) expect(stand.ampeln.some((a) => a.kachel === k)).toBe(true);
  });

  it("bewertet die echten Werte richtig", () => {
    const a = (s: string) => stand.ampeln.find((x) => x.schluessel === s)!;
    // 5-Minuten-Mittel 82 °C, Minuten-Spitze 90 °C → gut mit Hinweis auf die Spitze
    expect(a("cpu.temp").stufe).toBe("gut");
    expect(a("cpu.temp").text).toContain(`Spitze ${echtesPaket.rig.cpu.temp_c_max_1min} °C`);
    expect(a("gpu.temp").stufe).toBe("gut");
    expect(a("ram.verfuegbar").stufe).toBe("gut");
    expect(a("ram.trustone")).toMatchObject({ stufe: "neutral", neutral: "info", alarm: false });
    expect(a("ssd.gesundheit").stufe).toBe("gut");
    expect(a("platte.system").stufe).toBe("gut");
    expect(a("nas.volume").stufe).toBe("gut");
    expect(a("nas.freigaben").stufe).toBe("gut");
    expect(a("messwerte.frische").stufe).toBe("gut");
    expect(a("verbindung.online").stufe).toBe("gut");
    for (const d of DIENST_NAMEN) expect(a(`dienst.${d}`).stufe).toBe("gut");
    // SNMP ruht: alle NAS-Hardware-Ampeln neutral «kommt mit NAS-Zugang», ohne Alarm
    const hw = stand.ampeln.filter((x) => x.schluessel.startsWith("nas.hw."));
    expect(hw.length).toBeGreaterThanOrEqual(5);
    for (const x of hw) {
      expect(x).toMatchObject({ stufe: "neutral", neutral: "kommt" });
      expect(x.text).toMatch(/NAS-Zugang/);
    }
    expect(stand.gesamt.stufe).toBe("gut");
  });

  it("liefert Reihen im Format [t_ms, mittel, spitze] fuer alle Kurven der Seite", () => {
    const r = stand.reihen!;
    expect(r).toMatchObject({ bereich: "6h", schritt_s: 60 });
    expect(Object.keys(r.werte).sort()).toEqual([...REIHEN_SCHLUESSEL].sort());
    expect(SEITE_REIHEN.filter((s) => !(s in r.werte))).toEqual([]);
    for (const punkte of Object.values(r.werte)) {
      for (const [t, m, s] of punkte) {
        expect(Number.isFinite(t)).toBe(true);
        expect(m === null || Number.isFinite(m)).toBe(true);
        expect(s === null || Number.isFinite(s)).toBe(true);
      }
    }
    const cpu = r.werte["cpu.temp"];
    expect(cpu).toHaveLength(2);
    expect(cpu[0]).toEqual([Math.floor(Date.parse(echtesPaket.rig.gemessen_am) / 60_000) * 60_000, echtesPaket.rig.minute["cpu.temp"], echtesPaket.rig.minute["cpu.temp.max"]]);
    expect(r.werte["ki.warteschlange"].length).toBeGreaterThan(0);
    expect(r.werte["nas.belegt_prozent"].length).toBeGreaterThan(0);
    expect(r.neustarts).toEqual([]);
  });

  it("gibt weder den Kartennamen aus ki_status noch Adressen oder Hardware-Marken aus", () => {
    const text = JSON.stringify(stand);
    expect(text).not.toContain("KARTENNAME");
    expect(text).not.toMatch(/\b(\d{1,3}\.){3}\d{1,3}\b/);
    expect(text).not.toMatch(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
    expect(text).not.toMatch(/\/mnt\/|nvidia|geforce|intel|amd\b|samsung|ugreen|asus|corsair|kingston|crucial/i);
  });

  it("Cron-Lauf mit dem echten Stand: Zustaende angelegt, kein Alarm, keine Meldung", async () => {
    const r = await alarmLauf(fakeClient as never, new Date(jetzt));
    expect(r).toMatchObject({ success: true, alarme: 0, entwarnungen: 0 });
    expect(r.gewechselt).toBe(stand.ampeln.length);
    expect(db.tabellen.technik_zustaende).toHaveLength(stand.ampeln.length);
    expect(db.tabellen.technik_ereignisse ?? []).toEqual([]);
    const { notifyTechnikAlarm } = await import("@/lib/notification-service");
    expect(notifyTechnikAlarm).not.toHaveBeenCalled();
    // Zweiter Lauf ohne Aenderung: nichts gewechselt
    expect((await alarmLauf(fakeClient as never, new Date(jetzt + 30_000))).gewechselt).toBe(0);
  });
});
