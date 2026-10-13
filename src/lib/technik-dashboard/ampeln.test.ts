import { describe, expect, it } from "vitest";
import { bewerteAmpeln, dauer, datumZeit, gesamtAus, kachelStufe, stufeNachAlter, stufeNachGrenze, vorDauer, zahlDe, type AmpelEingabe } from "./ampeln";
import { DIENST_NAMEN, GRENZEN } from "./konstanten";
import type { Ampel, FsmStand, KiPaket, NasPaket, RigPaket } from "./typen";

const JETZT = new Date("2026-10-12T12:00:00Z");
const vor = (ms: number) => new Date(JETZT.getTime() - ms).toISOString();
const MIN = 60_000;
const H = 3600_000;
const GIB = 1024 ** 3;

function rig(over: Partial<RigPaket> = {}): RigPaket {
  return {
    gemessen_am: vor(20_000),
    uptime_s: 50_000,
    cpu: { temp_c: 71, temp_c_5min: 70, temp_c_max_1min: 75, last_prozent: 20, last_prozent_5min: 25, last_prozent_10min: 30, drosselung: false },
    gpu: { temp_c: 46, last_prozent: 0 },
    ram: {
      gesamt_b: 47 * GIB, verfuegbar_b: 35 * GIB, swap_gesamt_b: 8 * GIB, swap_belegt_b: 0.3 * GIB,
      psi_full_avg10: 0, seitenfehler_s: 0,
      ki: { fest_b: 1.4 * GIB, grenze_b: 22 * GIB },
      trustone: { summe_b: 11 * GIB, grenze_max_b: 20 * GIB },
    },
    platten: {
      system: { gesamt_b: 2e12, belegt_b: 0.3e12 },
      tresor: { gesamt_b: 210e9, belegt_b: 44e9 },
      ssd: { status: "ok", temp_c: 38, gesundheit: "ok", abnutzung_prozent: 3, betriebsstunden: 4120 },
    },
    dienste: DIENST_NAMEN.map((name) => ({ name, zustand: "laeuft" as const, gesund: true, neustarts: 0, oom: false })),
    minute: { "gpu.temp": 46 },
    ...over,
  };
}

function nas(over: Partial<NasPaket> = {}): NasPaket {
  return {
    gemessen_am: vor(30_000),
    erreichbar: true,
    fehlversuche_in_folge: 0,
    volume: { gesamt_b: 8e12, belegt_b: 0.533e12 },
    freigaben: { soll: 21, ist: 21, fehlt_seit: null },
    snmp: { status: "nicht_eingerichtet" },
    ...over,
  };
}

function fsm(over: Partial<FsmStand> = {}): FsmStand {
  return {
    ki_online: true,
    ki_letzter_poll: vor(2_000),
    ki_online_seit: vor(5 * H),
    ki_version: "0.1.0",
    ki_letzter_fehler: null,
    warteschlange_offen: 0,
    aeltester_offen_am: null,
    auftraege_24h: 3,
    backup: {
      letzte_ok_am: vor(9 * H), letzte_meldung_am: vor(9 * H), letzte_status: "ok",
      groesse_gesamt: null, groesse_db: null, groesse_dokumente: null, warnmails_7d: 0, letzte_warnmail_am: null, nie_gemeldet: false,
    },
    sync: { letzter_poll: vor(30_000), intervall_s: 60 },
    index: { letzter_scan: vor(8 * MIN), dateien: 449 },
    ...over,
  };
}

const ki: KiPaket = { warteschlange: 0, auftrag: null, fsm_antwort_ms: 210, fsm_fehler_in_folge: 0 };

function eingabe(over: Partial<AmpelEingabe> = {}): AmpelEingabe {
  return { jetzt: JETZT, rig: rig(), ki, nas: nas(), fsm: fsm(), abstuerze24h: {}, vorher: {}, ki_gemessen_am: vor(20_000), ...over };
}

function finde(ampeln: Ampel[], schluessel: string): Ampel {
  const a = ampeln.find((x) => x.schluessel === schluessel);
  if (!a) throw new Error(`Ampel ${schluessel} fehlt`);
  return a;
}
const ampel = (schluessel: string, over: Partial<AmpelEingabe> = {}) => finde(bewerteAmpeln(eingabe(over)), schluessel);
const mitCpu = (cpu: RigPaket["cpu"]) => ({ rig: rig({ cpu }) });

describe("Normalbetrieb", () => {
  it("ist ueberall gut oder neutral, Gesamt gut", () => {
    const ampeln = bewerteAmpeln(eingabe());
    expect(gesamtAus(ampeln)).toEqual({ stufe: "gut", probleme: [] });
    expect(finde(ampeln, "ram.trustone")).toMatchObject({ stufe: "neutral", neutral: "info", alarm: false, kachel: null });
    expect(finde(ampeln, "ki.warteschlange")).toMatchObject({ stufe: "neutral", neutral: "ruht", wert: "Ruht" });
    expect(finde(ampeln, "nas.hw.systemtemp")).toMatchObject({ stufe: "neutral", neutral: "kommt", text: "kommt mit NAS-Zugang" });
    expect(finde(ampeln, "cpu.temp")).toMatchObject({ stufe: "gut", wert: "71 °C" });
    expect(finde(ampeln, "nas.volume").text).toBe("533 GB von 8,0 TB belegt.");
    expect(finde(ampeln, "dienst.ki_dienst")).toMatchObject({ stufe: "gut", wert: "läuft" });
  });

  it("nennt keine Marken, Adressen oder Hostnamen", () => {
    const text = JSON.stringify(bewerteAmpeln(eingabe()));
    for (const verboten of ["NVIDIA", "Intel", "Samsung", "UGREEN", "RTX", "192.168", ".lan"]) expect(text).not.toContain(verboten);
  });
});

describe("Prozessor-Temperatur (5-Minuten-Mittel und Minuten-Spitze)", () => {
  it("Spitze 80–95 °C bleibt gut, nur mit Hinweis", () => {
    const a = ampel("cpu.temp", mitCpu({ temp_c: 71, temp_c_5min: 71, temp_c_max_1min: 84 }));
    expect(a.stufe).toBe("gut");
    expect(a.text).toContain("Spitze 84 °C, Warnung erst ab 95 °C");
    expect(ampel("cpu.temp", mitCpu({ temp_c_5min: 71, temp_c_max_1min: 79 })).text).not.toContain("Spitze");
  });

  it("Grenzen: Mittel > 85 oder Spitze ≥ 95 = Warnung, Spitze ≥ 98 oder Drosselung = kritisch", () => {
    expect(ampel("cpu.temp", mitCpu({ temp_c_5min: 85, temp_c_max_1min: 90 })).stufe).toBe("gut");
    expect(ampel("cpu.temp", mitCpu({ temp_c_5min: 85.1, temp_c_max_1min: 90 })).stufe).toBe("warnung");
    expect(ampel("cpu.temp", mitCpu({ temp_c_5min: 70, temp_c_max_1min: 94.9 })).stufe).toBe("gut");
    expect(ampel("cpu.temp", mitCpu({ temp_c_5min: 70, temp_c_max_1min: 95 })).stufe).toBe("warnung");
    expect(ampel("cpu.temp", mitCpu({ temp_c_5min: 70, temp_c_max_1min: 97.9 })).stufe).toBe("warnung");
    expect(ampel("cpu.temp", mitCpu({ temp_c_5min: 70, temp_c_max_1min: 98 })).stufe).toBe("kritisch");
    expect(ampel("cpu.temp", mitCpu({ temp_c_5min: 60, temp_c_max_1min: 60, drosselung: true })).stufe).toBe("kritisch");
  });

  it("Hysterese 3 °C: eine Warnung faellt erst unter Grenze − 3", () => {
    const vorher = { "cpu.temp": "warnung" as const };
    expect(ampel("cpu.temp", { ...mitCpu({ temp_c_5min: 83, temp_c_max_1min: 85 }), vorher }).stufe).toBe("warnung");
    expect(ampel("cpu.temp", { ...mitCpu({ temp_c_5min: 82, temp_c_max_1min: 85 }), vorher }).stufe).toBe("gut");
    expect(ampel("cpu.temp", { ...mitCpu({ temp_c_5min: 70, temp_c_max_1min: 93 }), vorher }).stufe).toBe("warnung");
    const vorherKrit = { "cpu.temp": "kritisch" as const };
    expect(ampel("cpu.temp", { ...mitCpu({ temp_c_5min: 80, temp_c_max_1min: 96 }), vorher: vorherKrit }).stufe).toBe("kritisch");
    expect(ampel("cpu.temp", { ...mitCpu({ temp_c_5min: 80, temp_c_max_1min: 94 }), vorher: vorherKrit }).stufe).toBe("warnung");
  });

  it("fehlende Werte sind neutral «nicht lesbar»", () => {
    expect(ampel("cpu.temp", mitCpu({ last_prozent: 3 }))).toMatchObject({ stufe: "neutral", neutral: "nicht_lesbar", alarm: false });
  });
});

describe("Grenzen mit Hysterese (allgemein)", () => {
  it("hoch: Warnung ab, kritisch ueber", () => {
    const g = GRENZEN["gpu.temp"];
    expect(stufeNachGrenze(74.9, g)).toBe("gut");
    expect(stufeNachGrenze(75, g)).toBe("warnung");
    expect(stufeNachGrenze(85, g)).toBe("warnung");
    expect(stufeNachGrenze(85.1, g)).toBe("kritisch");
    expect(stufeNachGrenze(82.5, g, "kritisch")).toBe("kritisch");
    expect(stufeNachGrenze(82, g, "kritisch")).toBe("warnung");
    expect(stufeNachGrenze(72, g, "warnung")).toBe("warnung");
    expect(stufeNachGrenze(71.9, g, "warnung")).toBe("gut");
  });

  it("tief: Arbeitsspeicher > 8 GB gut, 4–8 Warnung, < 4 kritisch, 0,5 GB Hysterese", () => {
    const g = GRENZEN["ram.verfuegbar"];
    expect(stufeNachGrenze(8.1, g)).toBe("gut");
    expect(stufeNachGrenze(8, g)).toBe("warnung");
    expect(stufeNachGrenze(4, g)).toBe("warnung");
    expect(stufeNachGrenze(3.9, g)).toBe("kritisch");
    expect(stufeNachGrenze(4.4, g, "kritisch")).toBe("kritisch");
    expect(stufeNachGrenze(4.6, g, "kritisch")).toBe("warnung");
    expect(stufeNachGrenze(8.4, g, "warnung")).toBe("warnung");
    expect(stufeNachGrenze(8.6, g, "warnung")).toBe("gut");
  });

  it("Speicherdruck faellt aus der Warnung wieder zurueck (Hysterese kleiner als Schwelle)", () => {
    const g = GRENZEN["ram.druck"];
    expect(stufeNachGrenze(5, g)).toBe("warnung");
    expect(stufeNachGrenze(3.5, g, "warnung")).toBe("warnung");
    expect(stufeNachGrenze(2.9, g, "warnung")).toBe("gut");
  });

  it("Alter: Warnung ab, kritisch ueber, ohne Hysterese", () => {
    const g = { warnung: 90_000, kritisch: 600_000 };
    expect(stufeNachAlter(89_999, g)).toBe("gut");
    expect(stufeNachAlter(90_000, g)).toBe("warnung");
    expect(stufeNachAlter(600_000, g)).toBe("warnung");
    expect(stufeNachAlter(600_001, g)).toBe("kritisch");
  });

  it("Arbeitsspeicher, Platten und KI-Bereich in der Ampel", () => {
    expect(ampel("ram.verfuegbar", { rig: rig({ ram: { verfuegbar_b: 6 * GIB } }) })).toMatchObject({ stufe: "warnung", wert: "6,0 GB frei" });
    expect(ampel("ram.verfuegbar", { rig: rig({ ram: { verfuegbar_b: 3 * GIB } }) }).stufe).toBe("kritisch");
    const platten = (belegt: number) => ({ rig: rig({ platten: { system: { gesamt_b: 1000, belegt_b: belegt } } }) });
    expect(ampel("platte.system", platten(799)).stufe).toBe("gut");
    expect(ampel("platte.system", platten(800)).stufe).toBe("warnung");
    expect(ampel("platte.system", platten(900)).stufe).toBe("warnung");
    expect(ampel("platte.system", platten(901)).stufe).toBe("kritisch");
    expect(ampel("ram.ki_fest", { rig: rig({ ram: { ki: { fest_b: 21 * GIB, grenze_b: 22 * GIB, cache_b: 22 * GIB } } }) }).stufe).toBe("kritisch");
  });
});

describe("Veraltete Messwerte", () => {
  it("Rig-Stand aelter 3 min: Messwerte Warnung, Rig-Ampeln neutral «veraltet» ohne Alarm", () => {
    const ampeln = bewerteAmpeln(eingabe({ rig: rig({ gemessen_am: vor(4 * MIN), cpu: { temp_c_5min: 99, temp_c_max_1min: 99 } }) }));
    expect(finde(ampeln, "messwerte.frische")).toMatchObject({ stufe: "warnung", wert: "vor 4 min", alarm: true });
    const cpu = finde(ampeln, "cpu.temp");
    expect(cpu).toMatchObject({ stufe: "neutral", neutral: "veraltet", alarm: false, text: "Stand vor 4 min." });
    expect(finde(ampeln, "dienst.ki_dienst").neutral).toBe("veraltet");
    expect(gesamtAus(ampeln).probleme.map((a) => a.schluessel)).toEqual(["messwerte.frische"]);
  });

  it("nie gemeldet: kritisch, aber ohne Alarm (vor dem ersten Paket)", () => {
    const ampeln = bewerteAmpeln(eingabe({ rig: null }));
    expect(finde(ampeln, "messwerte.frische")).toMatchObject({ stufe: "kritisch", wert: "nie", alarm: false });
    expect(finde(ampeln, "cpu.temp")).toMatchObject({ stufe: "neutral", neutral: "nie_gemeldet" });
  });

  it("Messwerte alarmieren nur, wenn das Rig online ist", () => {
    const offline = { fsm: fsm({ ki_online: false, ki_letzter_poll: vor(20 * MIN) }), rig: rig({ gemessen_am: vor(20 * MIN) }) };
    expect(ampel("messwerte.frische", offline)).toMatchObject({ stufe: "kritisch", alarm: false });
    expect(ampel("verbindung.online", offline)).toMatchObject({ stufe: "kritisch", alarm: true });
    expect(ampel("messwerte.frische", { rig: rig({ gemessen_am: vor(11 * MIN) }) })).toMatchObject({ stufe: "kritisch", alarm: true });
  });

  it("NAS-Messung aelter 5 min wird neutral", () => {
    expect(ampel("nas.volume", { nas: nas({ gemessen_am: vor(6 * MIN), volume: { gesamt_b: 100, belegt_b: 95 } }) })).toMatchObject({
      stufe: "neutral", neutral: "veraltet", alarm: false,
    });
  });
});

describe("Verbindung, KI, Dienste", () => {
  it("Rig online: < 90 s gut, ab 90 s Warnung, > 10 min kritisch", () => {
    expect(ampel("verbindung.online", { fsm: fsm({ ki_letzter_poll: vor(89_000) }) }).stufe).toBe("gut");
    expect(ampel("verbindung.online", { fsm: fsm({ ki_letzter_poll: vor(91_000) }) }).stufe).toBe("warnung");
    expect(ampel("verbindung.online", { fsm: fsm({ ki_letzter_poll: vor(11 * MIN) }) }).stufe).toBe("kritisch");
  });

  it("Antwortzeit: Warnung ab 1 s, kritisch ueber 3 s oder 3 Fehler in Folge, nie Alarm", () => {
    expect(ampel("verbindung.antwortzeit", { ki: { fsm_antwort_ms: 210 } })).toMatchObject({ stufe: "gut", wert: "0,21 s" });
    expect(ampel("verbindung.antwortzeit", { ki: { fsm_antwort_ms: 1500 } }).stufe).toBe("warnung");
    expect(ampel("verbindung.antwortzeit", { ki: { fsm_antwort_ms: 3001 } })).toMatchObject({ stufe: "kritisch", alarm: false });
    expect(ampel("verbindung.antwortzeit", { ki: { fsm_antwort_ms: 200, fsm_fehler_in_folge: 3 } }).stufe).toBe("kritisch");
  });

  it("Warteschlange: ruht, rechnet, Alter, offline neutral", () => {
    expect(ampel("ki.warteschlange", { ki: { auftrag: { art: "diktat", seit: vor(MIN) } } })).toMatchObject({ stufe: "gut", wert: "Rechnet" });
    expect(ampel("ki.warteschlange", { fsm: fsm({ warteschlange_offen: 2, aeltester_offen_am: vor(5 * MIN) }) }).stufe).toBe("gut");
    expect(ampel("ki.warteschlange", { fsm: fsm({ warteschlange_offen: 2, aeltester_offen_am: vor(11 * MIN) }) }).stufe).toBe("warnung");
    expect(ampel("ki.warteschlange", { fsm: fsm({ warteschlange_offen: 2, aeltester_offen_am: vor(31 * MIN) }) }).stufe).toBe("kritisch");
    expect(ampel("ki.warteschlange", { fsm: fsm({ ki_online: false, warteschlange_offen: 2, aeltester_offen_am: vor(31 * MIN) }) })).toMatchObject({
      stufe: "neutral", alarm: false,
    });
  });

  it("Dienste: Absturz in 24 h = Warnung, krank/gestoppt/Speichermangel = kritisch", () => {
    const mit = (d: Partial<NonNullable<RigPaket["dienste"]>[number]>) => ({
      rig: rig({ dienste: [{ name: "ollama_schnell", zustand: "laeuft", gesund: null, ...d }] }),
    });
    expect(ampel("dienst.ollama_schnell", mit({}))).toMatchObject({ stufe: "gut", titel: "Ollama schnell" });
    expect(ampel("dienst.ollama_schnell", { ...mit({}), abstuerze24h: { ollama_schnell: 2 } }).stufe).toBe("warnung");
    expect(ampel("dienst.ollama_schnell", mit({ zustand: "startet" })).stufe).toBe("warnung");
    expect(ampel("dienst.ollama_schnell", mit({ gesund: false })).stufe).toBe("kritisch");
    expect(ampel("dienst.ollama_schnell", mit({ zustand: "gestoppt" })).stufe).toBe("kritisch");
    expect(ampel("dienst.ollama_schnell", mit({ oom: true })).stufe).toBe("kritisch");
  });

  it("SSD ohne Messprogramm: neutral «kommt mit Freigabe am Rig»", () => {
    const r = rig({ platten: { ssd: { status: "nicht_verfuegbar" } } });
    expect(ampel("ssd.temp", { rig: r })).toMatchObject({ stufe: "neutral", neutral: "kommt", text: "kommt mit Freigabe am Rig" });
    expect(ampel("ssd.gesundheit", { rig: r }).neutral).toBe("kommt");
    expect(ampel("ssd.gesundheit", { rig: rig({ platten: { ssd: { status: "ok", gesundheit: "ok", abnutzung_prozent: 91 } } }) }).stufe).toBe("warnung");
    expect(ampel("ssd.temp", { rig: rig({ platten: { ssd: { status: "ok", temp_c: 71 } } }) }).stufe).toBe("kritisch");
  });
});

describe("NAS", () => {
  it("Erreichbarkeit: 1–2 Fehlversuche Warnung, ab 3 kritisch", () => {
    expect(ampel("nas.erreichbar", { nas: nas({ fehlversuche_in_folge: 1 }) }).stufe).toBe("warnung");
    expect(ampel("nas.erreichbar", { nas: nas({ fehlversuche_in_folge: 2 }) }).stufe).toBe("warnung");
    expect(ampel("nas.erreichbar", { nas: nas({ erreichbar: false, fehlversuche_in_folge: 3 }) })).toMatchObject({ stufe: "kritisch", wert: "Nicht erreichbar" });
  });

  it("Freigaben: Soll offen neutral, fehlt < 10 min Warnung, > 10 min kritisch", () => {
    expect(ampel("nas.freigaben", { nas: nas({ freigaben: { soll: null, ist: 21 } }) }).neutral).toBe("soll_offen");
    expect(ampel("nas.freigaben", { nas: nas({ freigaben: { soll: 21, ist: 20, fehlt_seit: vor(5 * MIN) } }) }).stufe).toBe("warnung");
    expect(ampel("nas.freigaben", { nas: nas({ freigaben: { soll: 21, ist: 20, fehlt_seit: vor(11 * MIN) } }) }).stufe).toBe("kritisch");
  });

  it("Hardware ruht bis zum SNMP-Zugang; Fehler nur als Warnung ohne Alarm", () => {
    const ohne = bewerteAmpeln(eingabe());
    for (const s of ["nas.hw.systemtemp", "nas.hw.plattentemp", "nas.hw.plattengesundheit", "nas.hw.raid", "nas.hw.zugang"]) {
      expect(finde(ohne, s)).toMatchObject({ stufe: "neutral", neutral: "kommt", alarm: false });
    }
    const fehler = bewerteAmpeln(eingabe({ nas: nas({ snmp: { status: "fehler", grund: "anmeldung" } }) }));
    expect(finde(fehler, "nas.hw.zugang")).toMatchObject({ stufe: "warnung", alarm: false });
    expect(finde(fehler, "nas.hw.raid").neutral).toBe("nicht_lesbar");
  });

  it("Hardware mit SNMP-Zugang", () => {
    const ok = bewerteAmpeln(eingabe({
      nas: nas({ snmp: { status: "ok", system_temp_c: 72, platten: [{ schacht: 1, temp_c: 40, gesundheit: "ok" }, { schacht: 2, temp_c: 56, gesundheit: "warnung" }], raid: "degradiert" } }),
    }));
    expect(finde(ok, "nas.hw.systemtemp").stufe).toBe("warnung");
    expect(finde(ok, "nas.hw.plattentemp")).toMatchObject({ stufe: "kritisch", alarm: true, wert: "56 °C" });
    expect(finde(ok, "nas.hw.plattengesundheit").stufe).toBe("warnung");
    expect(finde(ok, "nas.hw.raid").stufe).toBe("kritisch");
    expect(finde(ok, "nas.hw.zugang").stufe).toBe("gut");
    expect(finde(ok, "nas.hw.plattentemp").text).toBe("Wärmste Platte 56 °C (Schacht 02), kritisch über 55 °C.");
    expect(finde(ok, "nas.hw.plattengesundheit").text).toBe("Eine Platte meldet eine Warnung (Schacht 02).");
  });

  it("Externe Platten (USB): gleiche Grenzen, Texte nennen «USB-Platte» statt Schacht", () => {
    const schaechte = [1, 2, 3, 4].map((schacht) => ({ schacht, temp_c: 38, gesundheit: "ok" as const }));
    const eine = bewerteAmpeln(eingabe({
      nas: nas({ snmp: { status: "ok", quelle: "exporter", platten: [...schaechte, { schacht: 5, temp_c: 47, gesundheit: "fehler", extern: true }] } }),
    }));
    expect(finde(eine, "nas.hw.plattentemp")).toMatchObject({ stufe: "warnung", wert: "47 °C", text: "Wärmste Platte 47 °C (USB-Platte), Warnung ab 45 °C." });
    expect(finde(eine, "nas.hw.plattengesundheit")).toMatchObject({ stufe: "kritisch", text: "Eine Platte meldet einen Fehler (USB-Platte)." });
    const zwei = bewerteAmpeln(eingabe({
      nas: nas({ snmp: { status: "ok", quelle: "exporter", platten: [
        { ...schaechte[0], gesundheit: "warnung" }, ...schaechte.slice(1),
        { schacht: 6, temp_c: 30, gesundheit: "warnung", extern: true },
        { schacht: 5, temp_c: 56, gesundheit: "ok", extern: true },
      ] } }),
    }));
    expect(finde(zwei, "nas.hw.plattentemp")).toMatchObject({ stufe: "kritisch", text: "Wärmste Platte 56 °C (USB-Platte 1), kritisch über 55 °C." });
    expect(finde(zwei, "nas.hw.plattengesundheit")).toMatchObject({ stufe: "warnung", text: "2 Platten melden eine Warnung (Schacht 01, USB-Platte 2)." });
    const gesund = bewerteAmpeln(eingabe({
      nas: nas({ snmp: { status: "ok", quelle: "exporter", platten: [...schaechte, { schacht: 5, temp_c: 33, gesundheit: "ok", extern: true }] } }),
    }));
    expect(finde(gesund, "nas.hw.plattentemp")).toMatchObject({ stufe: "gut", text: "Wärmste Platte 38 °C (Schacht 01)." });
    expect(finde(gesund, "nas.hw.plattengesundheit").text).toBe("Alle 5 Platten sind gesund.");
  });
});

describe("FSM-Quellen", () => {
  it("Backup: < 26 h gut, 26–48 h Warnung, > 48 h oder Fehl-Lauf kritisch, nie gemeldet neutral", () => {
    const bk = (over: Partial<FsmStand["backup"]>) => ({ fsm: fsm({ backup: { ...fsm().backup, ...over } }) });
    expect(ampel("backup.fsm", bk({ letzte_ok_am: vor(25 * H) })).stufe).toBe("gut");
    expect(ampel("backup.fsm", bk({ letzte_ok_am: vor(27 * H) })).stufe).toBe("warnung");
    expect(ampel("backup.fsm", bk({ letzte_ok_am: vor(8 * 24 * H) }))).toMatchObject({ stufe: "kritisch", wert: "8 Tage" });
    expect(ampel("backup.fsm", bk({ letzte_status: "fehler" })).stufe).toBe("kritisch");
    expect(ampel("backup.fsm", bk({ nie_gemeldet: true, letzte_ok_am: null })).neutral).toBe("nie_gemeldet");
  });

  it("Ablage-Abgleich und Datei-Index", () => {
    expect(ampel("ablage.sync", { fsm: fsm({ sync: { letzter_poll: vor(6 * MIN), intervall_s: 60 } }) }).stufe).toBe("warnung");
    expect(ampel("ablage.sync", { fsm: fsm({ sync: { letzter_poll: vor(16 * MIN), intervall_s: 60 } }) }).stufe).toBe("kritisch");
    expect(ampel("ablage.index", { fsm: fsm({ index: { letzter_scan: vor(31 * MIN), dateien: 1 } }) }).stufe).toBe("warnung");
    expect(ampel("ablage.index", { fsm: fsm({ index: { letzter_scan: vor(61 * MIN), dateien: 1 } }) }).stufe).toBe("kritisch");
  });
});

describe("Gesamt und Kacheln", () => {
  it("Gesamt = schlechteste Stufe, kritisch zuerst; Kachel = schlechteste Ampel der Kachel", () => {
    const ampeln = bewerteAmpeln(eingabe({
      fsm: fsm({ backup: { ...fsm().backup, letzte_ok_am: vor(8 * 24 * H) } }),
      rig: rig({ gpu: { temp_c: 80 }, minute: { "gpu.temp": 80 } }),
    }));
    const g = gesamtAus(ampeln);
    expect(g.stufe).toBe("kritisch");
    expect(g.probleme.map((a) => a.schluessel)).toEqual(["backup.fsm", "gpu.temp"]);
    expect(kachelStufe(ampeln, "backup")).toBe("kritisch");
    expect(kachelStufe(ampeln, "rig")).toBe("warnung");
    expect(kachelStufe(ampeln, "nas")).toBe("gut");
  });
});

describe("Anzeige-Helfer", () => {
  it("formatiert de-CH mit Komma und Zuercher Zeit", () => {
    expect(zahlDe(35.75, 1)).toBe("35,8");
    expect(dauer(45_000)).toBe("45 s");
    expect(dauer(4 * MIN)).toBe("4 min");
    expect(dauer(3 * H)).toBe("3 h");
    expect(dauer(24 * H)).toBe("24 h");
    expect(dauer(8 * 24 * H)).toBe("8 Tage");
    expect(vorDauer(8 * 24 * H)).toBe("vor 8 Tagen");
    expect(datumZeit("2026-10-03T01:00:00Z")).toBe("03.10., 03:00");
  });
});

describe("Folge-Alarme und fehlende Dienste (Review 2026-10-12)", () => {
  it("Rig weg: Ablage-Abgleich und Datei-Index zeigen kritisch, alarmieren aber nicht", () => {
    const weg = { fsm: fsm({ ki_online: false, ki_letzter_poll: vor(70 * MIN), sync: { letzter_poll: vor(70 * MIN), intervall_s: 60 }, index: { letzter_scan: vor(70 * MIN), dateien: 449 } }) };
    expect(ampel("verbindung.online", weg)).toMatchObject({ stufe: "kritisch", alarm: true });
    expect(ampel("ablage.sync", weg)).toMatchObject({ stufe: "kritisch", alarm: false });
    expect(ampel("ablage.index", weg)).toMatchObject({ stufe: "kritisch", alarm: false });
    // Messwerte fehlen (Rig meldet sich, Sammler steht): ebenfalls nur eine Meldung
    const stumm = { rig: rig({ gemessen_am: vor(30 * MIN) }), fsm: fsm({ sync: { letzter_poll: vor(30 * MIN), intervall_s: 60 } }) };
    expect(ampel("ablage.sync", stumm)).toMatchObject({ stufe: "kritisch", alarm: false });
    // Rig da, nur der Abgleich steht: alarmiert
    const nurSync = { fsm: fsm({ sync: { letzter_poll: vor(30 * MIN), intervall_s: 60 } }) };
    expect(ampel("ablage.sync", nurSync)).toMatchObject({ stufe: "kritisch", alarm: true });
  });

  it("ein entfernter Pflichtdienst ergibt «fehlt» (kritisch, alarmiert); gruendlich nur mit Hauptmodell", () => {
    const ohne = (n: string) => rig().dienste!.filter((d) => d.name !== n);
    expect(ampel("dienst.whisper", { rig: rig({ dienste: ohne("whisper") }) })).toMatchObject({ stufe: "kritisch", wert: "fehlt", alarm: true });
    const ohneG = bewerteAmpeln(eingabe({ rig: rig({ dienste: ohne("ollama_gruendlich") }) }));
    expect(ohneG.some((a) => a.schluessel === "dienst.ollama_gruendlich")).toBe(false);
    expect(ampel("dienst.ollama_gruendlich", { rig: rig({ dienste: ohne("ollama_gruendlich") }), ki: { ...ki, schalter: { hauptmodell: true } } }).stufe).toBe("kritisch");
    // docker nicht lesbar (dienste fehlt ganz): keine «fehlt»-Ampeln
    expect(bewerteAmpeln(eingabe({ rig: rig({ dienste: undefined }) })).some((a) => a.wert === "fehlt")).toBe(false);
    // veraltete Messwerte: auch «fehlt» wird neutral
    expect(ampel("dienst.whisper", { rig: rig({ dienste: ohne("whisper"), gemessen_am: vor(30 * MIN) }) }).stufe).toBe("neutral");
  });

  it("SNMP-Datei ungueltig: Zugang als Warnung benannt, Hardware bleibt «kommt»", () => {
    const n = { nas: nas({ snmp: { status: "nicht_eingerichtet", grund: "zugang_ungueltig" } }) };
    expect(ampel("nas.hw.zugang", n)).toMatchObject({ stufe: "warnung", wert: "ungültig", alarm: false });
    expect(ampel("nas.hw.systemtemp", n)).toMatchObject({ stufe: "neutral", neutral: "kommt" });
  });
});

describe("Kuehlung (§2.5)", () => {
  const kue = (k: RigPaket["kuehlung"], over: Partial<RigPaket> = {}) => ({ rig: rig({ kuehlung: k, ...over }) });
  const ok: NonNullable<RigPaket["kuehlung"]> = {
    status: "ok", profil_aktiv: "ausgewogen", pumpe_rpm: 2100, pumpe_prozent: 60, kuehlmittel_c: 31.5, leds: "aus",
    luefter: [{ nr: 1, ort: "radiator", rpm: 1200, prozent: 40 }, { nr: 2, ort: "front", rpm: 900, prozent: 35 }],
  };

  it("fehlt oder nicht eingerichtet: ruhig neutral, kein Alarm", () => {
    expect(ampel("kuehlung")).toMatchObject({ stufe: "neutral", neutral: "kommt", alarm: false, bauteil: "cpu", kachel: "rig", text: "Kühlungs-Steuerung noch nicht eingerichtet." });
    expect(ampel("kuehlung", kue({ status: "nicht_eingerichtet", pumpe_rpm: 0 }))).toMatchObject({ stufe: "neutral", neutral: "kommt", alarm: false });
    expect(gesamtAus(bewerteAmpeln(eingabe(kue({ status: "nicht_eingerichtet" })))).stufe).toBe("gut");
  });

  it("Normalbetrieb: gut mit Pumpendrehzahl und Kuehlmittel", () => {
    expect(ampel("kuehlung", kue(ok))).toMatchObject({ stufe: "gut", wert: `Pumpe ${zahlDe(2100)} U/min`, text: "Pumpe und Lüfter drehen. Kühlmittel 31,5 °C." });
  });

  it("Pumpe steht oder meldet keine Drehzahl: kritisch mit Alarm (Ueberhitzung)", () => {
    expect(ampel("kuehlung", kue({ ...ok, pumpe_rpm: 0 }))).toMatchObject({ stufe: "kritisch", alarm: true, wert: "Pumpe steht", text: "Die Pumpe steht, der Prozessor kann überhitzen." });
    expect(ampel("kuehlung", kue({ ...ok, pumpe_rpm: undefined }))).toMatchObject({ stufe: "kritisch", alarm: true, text: "Die Pumpe meldet keine Drehzahl, der Prozessor kann überhitzen." });
    // auch bei gemeldetem Fehler zaehlt eine stehende Pumpe
    expect(ampel("kuehlung", kue({ status: "fehler", pumpe_rpm: 0 }))).toMatchObject({ stufe: "kritisch", alarm: true });
    // stehender Luefter wird im selben Satz genannt
    expect(ampel("kuehlung", kue({ ...ok, pumpe_rpm: 0, luefter: [{ nr: 2, ort: "front", rpm: 0, prozent: 50 }] })).text)
      .toBe("Die Pumpe steht, der Prozessor kann überhitzen. Lüfter 2 (Front) steht.");
  });

  it("ein Luefter steht: Warnung ohne Alarm; 0 U/min bei 0 % ist gewollt", () => {
    const steht = { ...ok, luefter: [{ nr: 1, ort: "radiator" as const, rpm: 1200, prozent: 40 }, { nr: 3, ort: "front" as const, rpm: 0, prozent: 35 }] };
    expect(ampel("kuehlung", kue(steht))).toMatchObject({ stufe: "warnung", alarm: false, wert: "Lüfter steht", text: "Lüfter 3 (Front) steht." });
    const zwei = { ...ok, luefter: [{ nr: 1, ort: "radiator" as const, rpm: 0 }, { nr: 3, ort: "unbekannt" as const, rpm: 0, prozent: 20 }] };
    expect(ampel("kuehlung", kue(zwei))).toMatchObject({ stufe: "warnung", wert: "2 Lüfter stehen", text: "2 Lüfter stehen: Lüfter 1 (Radiator), Lüfter 3." });
    const gewollt = { ...ok, luefter: [{ nr: 1, ort: "front" as const, rpm: 0, prozent: 0 }] };
    expect(ampel("kuehlung", kue(gewollt)).stufe).toBe("gut");
    // ohne Drehzahl ist nichts bekannt
    expect(ampel("kuehlung", kue({ ...ok, luefter: [{ nr: 1, ort: "front" }] })).stufe).toBe("gut");
  });

  it("Steuerung meldet Fehler: Warnung ohne Alarm, Code im Text", () => {
    expect(ampel("kuehlung", kue({ status: "fehler", grund: "sensor_fehlt", pumpe_rpm: 2000 }))).toMatchObject({ stufe: "warnung", alarm: false, wert: "Fehler", text: "Die Kühlungs-Steuerung auf dem Rig meldet einen Fehler (Code sensor_fehlt)." });
    expect(ampel("kuehlung", kue({ status: "fehler" }))).toMatchObject({ stufe: "warnung", alarm: false, text: "Die Kühlungs-Steuerung auf dem Rig meldet einen Fehler." });
  });

  it("veraltete Messung: neutral, kein Alarm; zaehlt zur Rig-Kachel", () => {
    expect(ampel("kuehlung", kue({ ...ok, pumpe_rpm: 0 }, { gemessen_am: vor(30 * MIN) }))).toMatchObject({ stufe: "neutral", neutral: "veraltet", alarm: false });
    expect(kachelStufe(bewerteAmpeln(eingabe(kue({ ...ok, pumpe_rpm: 0 }))), "rig")).toBe("kritisch");
    expect(ampel("kuehlung", { rig: null })).toMatchObject({ stufe: "neutral", neutral: "nie_gemeldet" });
  });
});
