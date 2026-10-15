import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ampel, Stufe } from "./typen";
import type { ZustandZeile } from "./stand-server";

// ---- Attrappen ----------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  notifyTechnikAlarm: vi.fn(async () => {}),
  notifyTechnikEntwarnung: vi.fn(async () => {}),
  logError: vi.fn(),
  isMailConfigured: vi.fn(() => true),
  grundlagen: { zustaende: [] as unknown[] },
  ampeln: [] as unknown[],
}));

vi.mock("@/lib/notification-service", () => ({
  notifyTechnikAlarm: mocks.notifyTechnikAlarm,
  notifyTechnikEntwarnung: mocks.notifyTechnikEntwarnung,
}));
vi.mock("@/lib/log", () => ({ logError: mocks.logError }));
vi.mock("@/lib/mail", () => ({ isMailConfigured: mocks.isMailConfigured }));
vi.mock("./stand-server", () => ({
  ladeGrundlagen: vi.fn(async () => mocks.grundlagen),
  ampelnAus: vi.fn(() => mocks.ampeln),
}));

import { alarmLauf, alarmTitel, planeAlarme } from "./alarme";
import { bewerteAmpeln } from "./ampeln";

const JETZT = new Date("2026-10-12T12:00:00Z");
const MIN = 60_000;
const H = 3600_000;
const vor = (ms: number) => new Date(JETZT.getTime() - ms).toISOString();

function a(schluessel: string, stufe: Stufe, over: Partial<Ampel> = {}): Ampel {
  return {
    schluessel, bauteil: "cpu", kachel: "rig", stufe, titel: `Titel ${schluessel}`, wert: null,
    text: `Text ${schluessel}.`, seit: null, alarm: true, ...(stufe === "neutral" ? { neutral: "veraltet", alarm: false } : {}), ...over,
  };
}

function z(schluessel: string, stufe: Stufe, over: Partial<ZustandZeile> = {}): ZustandZeile {
  return { schluessel, stufe, seit: vor(H), kritisch_seit: stufe === "kritisch" ? vor(H) : null, alarm_gesendet_am: null, alarm_offen: false, ...over };
}

// ---- Planung (rein) -------------------------------------------------------------

describe("planeAlarme", () => {
  it("neu kritisch: Zustand + Ereignis, aber noch kein Alarm (erst nach 10 min)", () => {
    const plan = planeAlarme([a("cpu.temp", "kritisch")], [z("cpu.temp", "gut")], JETZT);
    expect(plan.zustaende).toEqual([{ schluessel: "cpu.temp", stufe: "kritisch", seit: JETZT.toISOString(), kritisch_seit: JETZT.toISOString(), aktualisiert: JETZT.toISOString() }]);
    expect(plan.ereignisse).toEqual([expect.objectContaining({ art: "zustand", stufe: "kritisch", text: "Titel cpu.temp: Kritisch – Text cpu.temp." })]);
    expect(plan.alarme).toEqual([]);
  });

  it("alarmiert erst, wenn seit mindestens 10 min ununterbrochen kritisch", () => {
    const k = [a("cpu.temp", "kritisch")];
    expect(planeAlarme(k, [z("cpu.temp", "kritisch", { kritisch_seit: vor(9 * MIN) })], JETZT).alarme).toEqual([]);
    expect(planeAlarme(k, [z("cpu.temp", "kritisch", { kritisch_seit: vor(10 * MIN) })], JETZT).alarme).toHaveLength(1);
    // ohne kritisch_seit gilt seit
    expect(planeAlarme(k, [z("cpu.temp", "kritisch", { kritisch_seit: null, seit: vor(11 * MIN) })], JETZT).alarme).toHaveLength(1);
  });

  it("Drossel: neuer Vorfall nach Entwarnung frühestens 6 h nach dem letzten Alarm", () => {
    const k = [a("cpu.temp", "kritisch")];
    expect(planeAlarme(k, [z("cpu.temp", "kritisch", { alarm_gesendet_am: vor(5 * H + 59 * MIN), alarm_offen: false })], JETZT).alarme).toEqual([]);
    expect(planeAlarme(k, [z("cpu.temp", "kritisch", { alarm_gesendet_am: vor(6 * H), alarm_offen: false })], JETZT).alarme).toHaveLength(1);
  });

  it("Erinnerung: ein andauerndes (nicht entwarntes) Problem hoechstens 1× pro 24 h", () => {
    const k = [a("cpu.temp", "kritisch")];
    expect(planeAlarme(k, [z("cpu.temp", "kritisch", { alarm_gesendet_am: vor(6 * H), alarm_offen: true })], JETZT).alarme).toEqual([]);
    expect(planeAlarme(k, [z("cpu.temp", "kritisch", { alarm_gesendet_am: vor(23 * H + 59 * MIN), alarm_offen: true })], JETZT).alarme).toEqual([]);
    expect(planeAlarme(k, [z("cpu.temp", "kritisch", { alarm_gesendet_am: vor(24 * H), alarm_offen: true })], JETZT).alarme).toHaveLength(1);
  });

  it("keine Alarme fuer Warnungen, neutrale oder nicht alarmierende Ampeln", () => {
    const ampeln = [
      a("cpu.last", "kritisch", { alarm: false }),
      a("gpu.temp", "warnung"),
      a("ssd.temp", "neutral"),
    ];
    const zustaende = [z("cpu.last", "kritisch"), z("gpu.temp", "warnung"), z("ssd.temp", "neutral")];
    expect(planeAlarme(ampeln, zustaende, JETZT)).toEqual({ zustaende: [], ereignisse: [], alarme: [], entwarnungen: [] });
  });

  it("Entwarnung nur bei echtem Befund (gut/Warnung), nicht bei veraltet", () => {
    const offen = (stufe: Stufe) => [z("cpu.temp", stufe === "neutral" ? "kritisch" : "kritisch", { alarm_offen: true, alarm_gesendet_am: vor(H) })];
    expect(planeAlarme([a("cpu.temp", "gut")], offen("gut"), JETZT).entwarnungen).toHaveLength(1);
    expect(planeAlarme([a("cpu.temp", "warnung")], offen("warnung"), JETZT).entwarnungen).toHaveLength(1);
    expect(planeAlarme([a("cpu.temp", "neutral")], offen("neutral"), JETZT).entwarnungen).toEqual([]);
    expect(planeAlarme([a("cpu.temp", "gut")], [z("cpu.temp", "kritisch")], JETZT).entwarnungen).toEqual([]);
  });

  it("gut ↔ neutral wird gespeichert, erzeugt aber kein Ereignis; erste Sichtung nur bei Problemen", () => {
    const plan = planeAlarme([a("cpu.temp", "neutral"), a("gpu.temp", "gut"), a("ram.swap", "warnung")], [z("cpu.temp", "gut")], JETZT);
    expect(plan.zustaende.map((x) => x.schluessel)).toEqual(["cpu.temp", "gpu.temp", "ram.swap"]);
    expect(plan.ereignisse.map((e) => e.schluessel)).toEqual(["ram.swap"]);
  });

  it("RAM-Neuregel 15.10.2026: belegte Auslagerung und aktives Auslagern alarmieren nie", () => {
    const GIB = 1024 ** 3;
    const fsm = {
      ki_online: true, ki_letzter_poll: vor(2_000), ki_online_seit: vor(5 * H), ki_version: "0.1.0", ki_letzter_fehler: null,
      warteschlange_offen: 0, aeltester_offen_am: null, auftraege_24h: 0,
      backup: { letzte_ok_am: vor(9 * H), letzte_meldung_am: vor(9 * H), letzte_status: "ok" as const, groesse_gesamt: null, groesse_db: null, groesse_dokumente: null, warnmails_7d: 0, letzte_warnmail_am: null, nie_gemeldet: false },
      sync: { letzter_poll: vor(30_000), intervall_s: 60 }, index: { letzter_scan: vor(5 * MIN), dateien: 1 },
    };
    const ram = (over: Record<string, number>) => bewerteAmpeln({
      jetzt: JETZT, ki: null, nas: null, fsm, abstuerze24h: {}, vorher: {},
      rig: { gemessen_am: vor(20_000), ram: { gesamt_b: 47 * GIB, verfuegbar_b: 31 * GIB, swap_gesamt_b: 8 * GIB, swap_belegt_b: 2.7 * GIB, psi_some_avg10: 0, psi_full_avg10: 0, swap_ein_bps_5min: 0, swap_aus_bps_5min: 0, ...over } },
    }).filter((x) => x.bauteil === "ram");

    // Live-Fall: ram.swap stand seit 14.10. auf Warnung → jetzt Info: ein Hinweis-Ereignis, keine Mitteilung
    const heute = planeAlarme(ram({}), [z("ram.swap", "warnung")], JETZT);
    expect(heute.alarme).toEqual([]);
    expect(heute.entwarnungen).toEqual([]);
    expect(heute.ereignisse).toEqual([expect.objectContaining({ schluessel: "ram.swap", stufe: "hinweis", art: "zustand" })]);

    // Messnacht-Werte seit Stunden: Warnungen, aber nie ein Alarm (kritisch erst bei Stillstand oder < 4 GB frei)
    const nacht = ram({ verfuegbar_b: 11.9 * GIB, psi_some_avg10: 5.6, psi_full_avg10: 5.6, swap_belegt_b: 7.6 * GIB, swap_aus_bps_5min: 21.9 * 1024 ** 2 });
    const zNacht = nacht.map((x) => z(x.schluessel, x.stufe, { seit: vor(5 * H) }));
    expect(planeAlarme(nacht, zNacht, JETZT).alarme).toEqual([]);
    expect(nacht.filter((x) => x.stufe === "warnung").map((x) => x.schluessel).sort()).toEqual(["ram.auslagern", "ram.druck"]);
  });

  it("buendelt den Titel: schlimmstes Problem plus Anzahl weiterer", () => {
    expect(alarmTitel([a("x", "kritisch", { titel: "Prozessor-Temperatur" })])).toBe("Prozessor-Temperatur kritisch");
    expect(alarmTitel([a("x", "kritisch", { titel: "Tresor" }), a("y", "kritisch")])).toBe("Tresor kritisch und 1 weiteres Problem");
    expect(alarmTitel([a("x", "kritisch", { titel: "Tresor" }), a("y", "kritisch"), a("z", "kritisch")])).toBe("Tresor kritisch und 2 weitere Probleme");
  });
});

// ---- Lauf mit Datenbank-Attrappe ------------------------------------------------

type Zeile = Record<string, unknown>;

function fakeDb(start: { zustaende: Zeile[]; admins: Zeile[] }) {
  const tabellen: Record<string, Zeile[]> = {
    technik_zustaende: start.zustaende.map((r) => ({ ...r })),
    technik_ereignisse: [],
    profiles: start.admins,
  };
  function from(t: string) {
    const filter: Array<(r: Zeile) => boolean> = [];
    let aenderung: Zeile | null = null;
    const kette = {
      eq(col: string, val: unknown) { filter.push((r) => r[col] === val); return kette; },
      or(ausdruck: string) {
        // nur das Muster «spalte.is.null,spalte.lte.<iso>»
        const [, b] = ausdruck.split(",");
        const [spalte, , grenze] = b.split(/\.(?=lte\.)|(?<=lte)\./);
        filter.push((r) => r[spalte] == null || String(r[spalte]) <= grenze);
        return kette;
      },
      select() {
        const treffer = tabellen[t].filter((r) => filter.every((f) => f(r)));
        if (aenderung) for (const r of treffer) Object.assign(r, aenderung);
        return Promise.resolve({ data: treffer.map((r) => ({ ...r })), error: null });
      },
      then(ok: (v: unknown) => unknown) {
        return Promise.resolve({ data: tabellen[t].filter((r) => filter.every((f) => f(r))), error: null }).then(ok);
      },
    };
    return {
      select: () => kette,
      update(vals: Zeile) { aenderung = vals; return kette; },
      insert(rows: Zeile[]) { tabellen[t].push(...rows); return Promise.resolve({ error: null }); },
      upsert(rows: Zeile[]) {
        for (const row of rows) {
          const i = tabellen[t].findIndex((r) => r.schluessel === row.schluessel);
          if (i >= 0) Object.assign(tabellen[t][i], row);
          else tabellen[t].push({ alarm_gesendet_am: null, alarm_offen: false, ...row });
        }
        return Promise.resolve({ error: null });
      },
    };
  }
  return { tabellen, client: { from } as never };
}

describe("alarmLauf", () => {
  beforeEach(() => {
    mocks.notifyTechnikAlarm.mockClear();
    mocks.notifyTechnikEntwarnung.mockClear();
    mocks.logError.mockClear();
  });

  it("buendelt alle faelligen Alarme in EINE Mitteilung, Backup ohne Mail, und meldet beim naechsten Lauf nicht erneut", async () => {
    const zustaende = [
      z("cpu.temp", "kritisch", { kritisch_seit: vor(20 * MIN) }),
      z("platte.tresor", "kritisch", { kritisch_seit: vor(15 * MIN) }),
      z("backup.fsm", "kritisch", { kritisch_seit: vor(2 * H) }),
    ];
    mocks.grundlagen = { zustaende };
    mocks.ampeln = [
      a("cpu.temp", "kritisch", { titel: "Prozessor-Temperatur" }),
      a("platte.tresor", "kritisch", { titel: "Tresor", bauteil: "platten" }),
      a("backup.fsm", "kritisch", { titel: "FSM-Sicherung aufs NAS", bauteil: "backup" }),
    ];
    const db = fakeDb({ zustaende: zustaende as unknown as Zeile[], admins: [{ id: "admin-1", role: "admin", is_active: true }, { id: "ma-1", role: "mitarbeiter", is_active: true }] });

    const erg = await alarmLauf(db.client, JETZT);
    expect(erg).toEqual({ success: true, gewechselt: 0, alarme: 3, entwarnungen: 0 });
    expect(mocks.notifyTechnikAlarm).toHaveBeenCalledTimes(1);
    const args = (mocks.notifyTechnikAlarm.mock.calls[0] as unknown[])[1] as { recipients: string[]; titel: string; zeilen: string[]; mail: { titel: string; zeilen: string[] } };
    expect(args.recipients).toEqual(["admin-1"]);
    expect(args.titel).toBe("Prozessor-Temperatur kritisch und 2 weitere Probleme");
    expect(args.zeilen).toHaveLength(3);
    expect(args.mail.zeilen).toHaveLength(2);
    expect(args.mail.zeilen.join(" ")).not.toContain("FSM-Sicherung");
    expect(db.tabellen.technik_ereignisse.filter((e) => e.art === "alarm")).toHaveLength(3);
    expect(db.tabellen.technik_zustaende.every((r) => r.alarm_offen === true && r.alarm_gesendet_am === JETZT.toISOString())).toBe(true);

    // Zweiter Lauf 5 min spaeter: Drossel greift (Planung sieht den neuen Zustand)
    mocks.grundlagen = { zustaende: db.tabellen.technik_zustaende as unknown as ZustandZeile[] };
    const spaeter = new Date(JETZT.getTime() + 5 * MIN);
    const erg2 = await alarmLauf(db.client, spaeter);
    expect(erg2.alarme).toBe(0);
    expect(mocks.notifyTechnikAlarm).toHaveBeenCalledTimes(1);

    // Problem dauert an (nicht entwarnt): nach 7 h noch keine Erinnerung, nach 24 h genau eine
    mocks.grundlagen = { zustaende: db.tabellen.technik_zustaende as unknown as ZustandZeile[] };
    expect((await alarmLauf(db.client, new Date(JETZT.getTime() + 7 * H))).alarme).toBe(0);
    mocks.grundlagen = { zustaende: db.tabellen.technik_zustaende as unknown as ZustandZeile[] };
    expect((await alarmLauf(db.client, new Date(JETZT.getTime() + 24 * H))).alarme).toBe(3);
    expect(mocks.notifyTechnikAlarm).toHaveBeenCalledTimes(2);
  });

  it("meldet nicht doppelt, wenn ein ueberlappender Lauf den Alarm schon beansprucht hat", async () => {
    const zustaende = [z("cpu.temp", "kritisch", { kritisch_seit: vor(20 * MIN) })];
    mocks.grundlagen = { zustaende }; // veralteter Blick: noch kein Alarm gesendet
    mocks.ampeln = [a("cpu.temp", "kritisch")];
    const db = fakeDb({ zustaende: [{ ...zustaende[0], alarm_gesendet_am: vor(MIN), alarm_offen: true }], admins: [{ id: "admin-1", role: "admin", is_active: true }] });
    const erg = await alarmLauf(db.client, JETZT);
    expect(erg.alarme).toBe(0);
    expect(mocks.notifyTechnikAlarm).not.toHaveBeenCalled();
  });

  it("Entwarnung ohne Mail-Funktion, genau einmal", async () => {
    const zustaende = [z("cpu.temp", "kritisch", { alarm_offen: true, alarm_gesendet_am: vor(H) })];
    mocks.grundlagen = { zustaende };
    mocks.ampeln = [a("cpu.temp", "gut", { titel: "Prozessor-Temperatur" })];
    const db = fakeDb({ zustaende: zustaende as unknown as Zeile[], admins: [{ id: "admin-1", role: "admin", is_active: true }] });
    const erg = await alarmLauf(db.client, JETZT);
    expect(erg).toEqual({ success: true, gewechselt: 1, alarme: 0, entwarnungen: 1 });
    expect(mocks.notifyTechnikEntwarnung).toHaveBeenCalledTimes(1);
    expect(((mocks.notifyTechnikEntwarnung.mock.calls[0] as unknown[])[1] as { titel: string }).titel).toBe("Prozessor-Temperatur wieder in Ordnung");
    expect(mocks.notifyTechnikAlarm).not.toHaveBeenCalled();
    expect(db.tabellen.technik_zustaende[0]).toMatchObject({ stufe: "gut", alarm_offen: false });
    expect(db.tabellen.technik_ereignisse.map((e) => e.art).sort()).toEqual(["entwarnung", "zustand"]);
  });

  it("wirft nie, sondern loggt", async () => {
    mocks.grundlagen = { zustaende: [] };
    mocks.ampeln = [a("cpu.temp", "kritisch")];
    const kaputt = { from: () => ({ upsert: () => Promise.resolve({ error: { message: "kaputt" } }) }) } as never;
    const erg = await alarmLauf(kaputt, JETZT);
    expect(erg.success).toBe(false);
    expect(mocks.logError).toHaveBeenCalledWith("cron.technik-alarme", expect.any(Error));
  });
});
