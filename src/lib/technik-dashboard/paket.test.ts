import { describe, expect, it } from "vitest";
import { kiMinutenwerte, leiteEreignisseAb, lesePaket, nasMinutenwerte } from "./paket";
import type { PaketV1, RigPaket } from "./typen";

const JETZT = Date.parse("2026-10-12T05:53:30Z");

/** Beispiel aus dem Vertrag §2.2 (Werte vom 12.10.). */
function beispiel(): Record<string, unknown> {
  return {
    v: 1,
    gesendet_am: "2026-10-12T05:53:10Z",
    rig: {
      gemessen_am: "2026-10-12T05:53:04Z",
      uptime_s: 53640,
      cpu: {
        temp_c: 71, temp_c_5min: 70.4, temp_c_max_1min: 84, kerne_temp_c: [53, 72], chipsatz_temp_c: 32,
        last_prozent: 23, last_prozent_5min: 31, last_prozent_10min: 43, takt_mhz: 3800, takt_mhz_max_kern: 4800,
        kerne: 10, threads: 20, drosselung: false, anteil_kerne: { ki: 0.8, trustone: 2.0 },
      },
      gpu: {
        temp_c: 46, temp_c_max_1min: 46, last_prozent: 0, vram_belegt_mib: 9, vram_gesamt_mib: 8192,
        watt: 20.4, watt_grenze: 270, luefter_prozent: 0, pstate: "P8", treiber: "595.91", takt_mhz: 210, takt_max_mhz: 2130,
      },
      ram: {
        eingebaut_gb: 48, module: [{ platz: 1, groesse_gb: 8 }, { platz: 2, groesse_gb: 16, temp_c: 42 }],
        gesamt_b: 50465865728, verfuegbar_b: 38440000000, frei_b: 20100000000, swap_gesamt_b: 8589934592, swap_belegt_b: 279000000,
        psi_full_avg10: 0, psi_some_avg10: 0, swap_ein_bps_5min: 0, swap_aus_bps_5min: 1310,
        ki: { belegt_b: 3650000000, fest_b: 1400000000, cache_b: 2250000000, grenze_b: 23622320128, swap_b: 322000000 },
        trustone: { summe_b: 11060000000, grenze_hoch_b: 19327352832, grenze_max_b: 21474836480 },
      },
      platten: {
        system: { gesamt_b: 1967000000000, belegt_b: 281000000000 },
        tresor: { gesamt_b: 210000000000, belegt_b: 44000000000 },
        ssd: { status: "ok", temp_c: 38, gesundheit: "ok", abnutzung_prozent: 3, betriebsstunden: 4120 },
      },
      io: { gelesen_b: 62900000000, geschrieben_b: 42100000000, netz_rx_b: 47300000000, netz_tx_b: 1400000000, vpn_rx_b: 1180000000, vpn_tx_b: 320000000 },
      dienste: [
        { name: "ki_dienst", zustand: "laeuft", gesund: true, gestartet_am: "2026-10-12T05:50:00Z", neustarts: 0, oom: false, speicher_b: 83886080, grenze_b: 4294967296 },
        { name: "webserver", zustand: "laeuft", gesund: null, gestartet_am: "2026-10-11T18:28:00Z", neustarts: 0, oom: false, speicher_b: 11534336, grenze_b: 268435456 },
      ],
      minute: { "cpu.temp": 70.8, "cpu.temp.max": 84, "cpu.last": 25.1, "cpu.last.max": 41, "gpu.temp": 46, "gpu.last": 0, "ram.verfuegbar_gb": 35.8 },
    },
    ki: {
      version: "0.1.0+20261012-0023", eingestellt: "gemma3:4b",
      instanzen: [
        { name: "schnell", erreichbar: true, version: "0.35.1", grenze_b: 12884901888 },
        { name: "gruendlich", erreichbar: true, version: "0.35.1", grenze_b: 20401094656 },
      ],
      modelle: [{ name: "gemma3:4b", groesse_b: 3300000000 }, { name: "gemma4:26b-a4b", groesse_b: 15600000000 }],
      geladen: [],
      auftrag: null, warteschlange: 0, tempo: null,
      archiv: { anzahl: 165, letzter_lauf: "2026-10-12T05:51:43Z", neu: 0, fehler: 0, dauer_s: 2.1 },
      tiefen_index: { dateien: 449, nas_dateien: 449, mit_text: 395, abschnitte: 2309, letzter_lauf: "2026-10-11T20:25:45Z", nacht_fertig: true },
      schalter: { suche: true, archiv_frage: true, hintergrund: false, lernen: false, tiefe: true, hauptmodell: false },
      hauptmodell_geladen: false, fsm_antwort_ms: 210, fsm_fehler_in_folge: 0,
    },
    nas: {
      gemessen_am: "2026-10-12T05:53:00Z", erreichbar: true, fehlversuche_in_folge: 0,
      dateifreigabe: true, weboberflaeche: true,
      volume: { gesamt_b: 7968531677184, belegt_b: 532500000000 },
      freigaben: { soll: 21, ist: 21, schreibend: 11, lesend: 10, fehlt_seit: null },
      snmp: { status: "nicht_eingerichtet" },
    },
  };
}

/** Leistungs-Block (§2.6) mit den echten Zahlen vom Rig (Stand 15.10.2026, Zeiten hierher verschoben). */
function leistungBeispiel(): Record<string, unknown> {
  const block = () => ({
    auftraege: [
      { art: "nacht_zz", n: 282, ok: 282, median_ms: 3958, max_ms: 13594 },
      { art: "nacht_fristen", n: 73, ok: 73, median_ms: 1854, max_ms: 6740 },
      { art: "nas_suche", n: 41, ok: 41, median_ms: 59, max_ms: 6235 },
      { art: "archiv_frage", n: 2, ok: 2, median_ms: 10233, max_ms: 14157 },
    ],
    gelesen: {
      dateien: 449, mit_text: 395, gescannt: 88, seiten: 668, seiten_max: 80, zeichen_max: 206385, mb_max: 17.5,
      s_seite_text: 0.5, s_seite_gescannt: 1.74, s_datei_median: 0.64, s_datei_max: 105.3,
    },
    fristen_geprueft: { dateien: 395, mit_frist: 73 },
    selbsttest: { laeufe: 3, top1: 0.533, top3: 0.683, top1_ohne_name: 0.4, top3_ohne_name: 0.6, ms_median: 4603 },
  });
  return {
    stand: "2026-10-12T05:50:00Z",
    seit: "2026-10-02T20:50:00Z",
    zeitraeume: { "7d": block(), "30d": block(), alle: block() },
    selbsttest: [
      { am: "2026-10-10T03:42:22Z", dateien: 40, top1: 0.6, top3: 0.75, top1_ohne_name: 0.475, top3_ohne_name: 0.725, ms_median: 4879 },
      { am: "2026-10-12T03:37:46Z", dateien: 40, top1: 0.45, top3: 0.65, top1_ohne_name: 0.325, top3_ohne_name: 0.575, ms_median: 4355 },
      { am: "2026-10-11T03:38:27Z", dateien: 40, top1: 0.55, top3: 0.65, top1_ohne_name: 0.4, top3_ohne_name: 0.5, ms_median: 4574 },
    ],
  };
}

function lies(roh: unknown): PaketV1 {
  const r = lesePaket(roh, JETZT);
  if ("fehler" in r) throw new Error(`unerwarteter Fehler: ${r.fehler}`);
  return r.paket;
}

describe("lesePaket: Rahmen", () => {
  it("nimmt das Vertragsbeispiel vollstaendig an", () => {
    const p = lies(beispiel());
    expect(p.v).toBe(1);
    expect(p.gesendet_am).toBe("2026-10-12T05:53:10.000Z");
    expect(p.rig?.cpu?.temp_c).toBe(71);
    expect(p.rig?.cpu?.kerne_temp_c).toEqual([53, 72]);
    expect(p.rig?.gpu?.pstate).toBe("P8");
    expect(p.rig?.ram?.module).toHaveLength(2);
    expect(p.rig?.platten?.ssd).toEqual({ status: "ok", temp_c: 38, gesundheit: "ok", abnutzung_prozent: 3, betriebsstunden: 4120 });
    expect(p.rig?.dienste?.map((d) => d.name)).toEqual(["ki_dienst", "webserver"]);
    expect(p.rig?.minute).toEqual({ "cpu.temp": 70.8, "cpu.temp.max": 84, "cpu.last": 25.1, "cpu.last.max": 41, "gpu.temp": 46, "gpu.last": 0, "ram.verfuegbar_gb": 35.8 });
    expect(p.ki?.modelle).toHaveLength(2);
    expect(p.ki?.auftrag).toBeNull();
    expect(p.ki?.tempo).toBeNull();
    expect(p.nas?.volume).toEqual({ gesamt_b: 7968531677184, belegt_b: 532500000000 });
    expect(p.nas?.freigaben?.fehlt_seit).toBeNull();
    expect(p.nas?.snmp).toEqual({ status: "nicht_eingerichtet" });
  });

  it("lehnt falsche Version, kaputten Rahmen und fehlendes gesendet_am ab", () => {
    expect(lesePaket({ ...beispiel(), v: 2 }, JETZT)).toEqual({ fehler: "version" });
    expect(lesePaket("text", JETZT)).toEqual({ fehler: "format" });
    expect(lesePaket([beispiel()], JETZT)).toEqual({ fehler: "format" });
    expect(lesePaket(null, JETZT)).toEqual({ fehler: "format" });
    const ohne = beispiel();
    delete ohne.gesendet_am;
    expect(lesePaket(ohne, JETZT)).toEqual({ fehler: "gesendet_am" });
    expect(lesePaket({ ...beispiel(), gesendet_am: "gestern" }, JETZT)).toEqual({ fehler: "gesendet_am" });
  });

  it("verwirft unbekannte Felder still (keine Marken, Namen, Adressen)", () => {
    const roh = beispiel();
    roh.hostname = "rig.lan";
    const rig = roh.rig as Record<string, unknown>;
    (rig.gpu as Record<string, unknown>).name = "Markenkarte 3070";
    (rig.cpu as Record<string, unknown>).modell = "Prozessor X";
    (roh.nas as Record<string, unknown>).adresse = "192.168.1.20";
    const p = lies(roh);
    const json = JSON.stringify(p);
    expect(json).not.toContain("rig.lan");
    expect(json).not.toContain("Markenkarte");
    expect(json).not.toContain("Prozessor X");
    expect(json).not.toContain("192.168");
  });

  it("toleriert fehlende Bloecke und Felder", () => {
    const p = lies({ v: 1, gesendet_am: "2026-10-12T05:53:10Z" });
    expect(p).toEqual({ v: 1, gesendet_am: "2026-10-12T05:53:10.000Z" });
    const nurRig = lies({ v: 1, gesendet_am: "2026-10-12T05:53:10Z", rig: { gemessen_am: "2026-10-12T05:53:04Z" } });
    expect(nurRig.rig).toEqual({ gemessen_am: "2026-10-12T05:53:04.000Z" });
  });

  it("verwirft einen Block ohne gueltigen Zeitstempel, nicht das Paket", () => {
    const roh = beispiel();
    (roh.rig as Record<string, unknown>).gemessen_am = "kaputt";
    (roh.nas as Record<string, unknown>).erreichbar = "ja";
    const p = lies(roh);
    expect(p.rig).toBeUndefined();
    expect(p.nas).toBeUndefined();
    expect(p.ki).toBeDefined();
  });
});

describe("lesePaket: Zahlen", () => {
  it("verwirft unplausible Temperaturen und klemmt Prozent", () => {
    const roh = beispiel();
    const cpu = (roh.rig as Record<string, Record<string, unknown>>).cpu;
    cpu.temp_c = 200;
    cpu.temp_c_5min = -40;
    cpu.last_prozent = 100.4;
    cpu.last_prozent_5min = 400;
    cpu.last_prozent_10min = -2;
    const p = lies(roh);
    expect(p.rig?.cpu?.temp_c).toBeUndefined();
    expect(p.rig?.cpu?.temp_c_5min).toBeUndefined();
    expect(p.rig?.cpu?.last_prozent).toBe(100);
    expect(p.rig?.cpu?.last_prozent_5min).toBeUndefined();
    expect(p.rig?.cpu?.last_prozent_10min).toBe(0);
  });

  it("verwirft negative oder zu grosse Bytes und Text statt Zahl", () => {
    const roh = beispiel();
    const ram = (roh.rig as Record<string, Record<string, unknown>>).ram;
    ram.gesamt_b = -1;
    ram.verfuegbar_b = 2 ** 60;
    ram.frei_b = "20100000000";
    ram.swap_belegt_b = Number.NaN;
    const p = lies(roh);
    expect(p.rig?.ram?.gesamt_b).toBeUndefined();
    expect(p.rig?.ram?.verfuegbar_b).toBeUndefined();
    expect(p.rig?.ram?.frei_b).toBeUndefined();
    expect(p.rig?.ram?.swap_belegt_b).toBeUndefined();
  });

  it("Ein-/Auslagern (§2.3): ganze Bytes/s, Unsinn faellt weg; Seitenfehler gibt es nicht mehr", () => {
    expect(lies(beispiel()).rig?.ram).toMatchObject({ swap_ein_bps_5min: 0, swap_aus_bps_5min: 1310 });
    const roh = beispiel();
    const ram = (roh.rig as Record<string, Record<string, unknown>>).ram;
    ram.swap_ein_bps_5min = 12.6;
    ram.swap_aus_bps_5min = -3;
    ram.seitenfehler_s = 1786;
    const p = lies(roh);
    expect(p.rig?.ram?.swap_ein_bps_5min).toBe(13);
    expect(p.rig?.ram?.swap_aus_bps_5min).toBeUndefined();
    expect(p.rig?.ram).not.toHaveProperty("seitenfehler_s");
    ram.swap_aus_bps_5min = 2e11;
    expect(lies(roh).rig?.ram?.swap_aus_bps_5min).toBeUndefined();
    (roh.rig as Record<string, unknown>).minute = { "ram.swap_ein_bps": 0, "ram.swap_aus_bps": 2048.5, "ram.seitenfehler_s": 4, "ram.seitenfehler_s.max": 9 };
    expect(lies(roh).rig?.minute).toEqual({ "ram.swap_ein_bps": 0, "ram.swap_aus_bps": 2048.5 });
  });

  it("verwirft Belegungen mit belegt > gesamt", () => {
    const roh = beispiel();
    (roh.rig as Record<string, Record<string, unknown>>).platten.system = { gesamt_b: 100, belegt_b: 200 };
    expect(lies(roh).rig?.platten?.system).toBeUndefined();
  });

  it("filtert Minutenwerte auf die erlaubten Schluessel", () => {
    const roh = beispiel();
    (roh.rig as Record<string, unknown>).minute = { "cpu.temp": 70.1234, "fremd.wert": 5, "gpu.last": "9", "ram.swap_gb": 0.26 };
    expect(lies(roh).rig?.minute).toEqual({ "cpu.temp": 70.123, "ram.swap_gb": 0.26 });
  });
});

describe("lesePaket: Texte, Listen, Zeiten", () => {
  it("laesst nur Texte durch, die den Weisslisten entsprechen", () => {
    const roh = beispiel();
    const gpu = (roh.rig as Record<string, Record<string, unknown>>).gpu;
    gpu.pstate = "P99x";
    gpu.treiber = "Treiber 595";
    const ki = roh.ki as Record<string, unknown>;
    ki.eingestellt = "gemma 3";
    ki.modelle = [{ name: "<script>", groesse_b: 1 }, { name: "qwen2.5:7b", groesse_b: 5 }];
    const p = lies(roh);
    expect(p.rig?.gpu?.pstate).toBeUndefined();
    expect(p.rig?.gpu?.treiber).toBeUndefined();
    expect(p.ki?.eingestellt).toBeUndefined();
    expect(p.ki?.modelle).toEqual([{ name: "qwen2.5:7b", groesse_b: 5 }]);
  });

  it("kappt Listen und verwirft fremde oder doppelte Dienste", () => {
    const roh = beispiel();
    const dienste = Array.from({ length: 20 }, () => ({ name: "whisper", zustand: "laeuft", gesund: true }));
    dienste.unshift({ name: "trust-bot", zustand: "laeuft", gesund: true });
    (roh.rig as Record<string, unknown>).dienste = dienste;
    const p = lies(roh);
    expect(p.rig?.dienste).toEqual([{ name: "whisper", zustand: "laeuft", gesund: true }]);

    const viele = Array.from({ length: 80 }, (_, i) => ({ name: `modell${i}:1b`, groesse_b: i }));
    (roh.ki as Record<string, unknown>).modelle = viele;
    expect(lies(roh).ki?.modelle).toHaveLength(50);
  });

  it("nimmt Auftragsarten nur aus KI_ARTEN", () => {
    const roh = beispiel();
    (roh.ki as Record<string, unknown>).auftrag = { art: "bitcoin_mining", seit: "2026-10-12T05:52:00Z" };
    expect(lies(roh).ki?.auftrag).toBeUndefined();
    (roh.ki as Record<string, unknown>).auftrag = { art: "beleg_analyse", seit: "2026-10-12T05:52:00Z", modell: "gemma3:4b" };
    expect(lies(roh).ki?.auftrag).toEqual({ art: "beleg_analyse", seit: "2026-10-12T05:52:00.000Z", modell: "gemma3:4b" });
  });

  it("verwirft Zeitstempel mehr als 5 min in der Zukunft (ausser Entlade-Zeit)", () => {
    const roh = beispiel();
    (roh.rig as Record<string, unknown>).gemessen_am = "2026-10-12T06:00:00Z";
    (roh.ki as Record<string, unknown>).geladen = [
      { name: "gemma3:4b", instanz: "schnell", groesse_b: 3300000000, vram_b: 3000000000, entlaedt_am: "2026-10-12T06:30:00Z" },
    ];
    const p = lies(roh);
    expect(p.rig).toBeUndefined();
    expect(p.ki?.geladen?.[0].entlaedt_am).toBe("2026-10-12T06:30:00.000Z");
    expect(lesePaket({ ...beispiel(), gesendet_am: "2026-10-12T06:00:00Z" }, JETZT)).toEqual({ fehler: "gesendet_am" });
  });

  it("verwirft Mess-Bloecke, die aelter als 24 h sind", () => {
    const roh = beispiel();
    (roh.nas as Record<string, unknown>).gemessen_am = "2026-10-10T05:53:00Z";
    expect(lies(roh).nas).toBeUndefined();
  });

  it("setzt SNMP ohne Block auf «nicht_eingerichtet» und nimmt Hardware-Werte nur bei ok", () => {
    const roh = beispiel();
    delete (roh.nas as Record<string, unknown>).snmp;
    expect(lies(roh).nas?.snmp).toEqual({ status: "nicht_eingerichtet" });
    (roh.nas as Record<string, unknown>).snmp = { status: "fehler", grund: "anmeldung", system_temp_c: 50, modell: "DXP" };
    expect(lies(roh).nas?.snmp).toEqual({ status: "fehler", grund: "anmeldung" });
    (roh.nas as Record<string, unknown>).snmp = {
      status: "ok", system_temp_c: 41, platten: [{ schacht: 1, temp_c: 36, gesundheit: "ok" }, { schacht: 1, temp_c: 99 }], raid: "normal", seriennummer: "X",
    };
    expect(lies(roh).nas?.snmp).toEqual({ status: "ok", system_temp_c: 41, platten: [{ schacht: 1, temp_c: 36, gesundheit: "ok" }], raid: "normal" });
  });

  it("nimmt Quelle und Platten-Zaehler der Mess-Container (Vertrag §1.4) und verwirft Namen und Unsinn", () => {
    const roh = beispiel();
    (roh.nas as Record<string, unknown>).snmp = {
      status: "ok", quelle: "exporter", raid: "degradiert", ram_prozent: 25, uptime_s: 3600,
      platten: [
        { schacht: 1, temp_c: 34, gesundheit: "ok", betriebsstunden: 12000, umgelagert: 0, ausstehend: 0, nicht_korrigierbar: 0, crc_fehler: 0 },
        { schacht: 2, gesundheit: "warnung", betriebsstunden: -5, umgelagert: 8, ausstehend: 2.5, crc_fehler: 185757286434, modell: "WD40EFPX", seriennummer: "WD-X", geraet: "sdb" },
      ],
    };
    expect(lies(roh).nas?.snmp).toEqual({
      status: "ok", quelle: "exporter", raid: "degradiert", ram_prozent: 25, uptime_s: 3600,
      platten: [
        { schacht: 1, temp_c: 34, gesundheit: "ok", betriebsstunden: 12000, umgelagert: 0, ausstehend: 0, nicht_korrigierbar: 0, crc_fehler: 0 },
        { schacht: 2, gesundheit: "warnung", umgelagert: 8 },
      ],
    });
    (roh.nas as Record<string, unknown>).snmp = { status: "nicht_eingerichtet", grund: "zugang_ungueltig", quelle: "exporter" };
    expect(lies(roh).nas?.snmp).toEqual({ status: "nicht_eingerichtet", grund: "zugang_ungueltig", quelle: "exporter" });
    (roh.nas as Record<string, unknown>).snmp = { status: "fehler", grund: "anmeldung", quelle: "rest-api" };
    expect(lies(roh).nas?.snmp).toEqual({ status: "fehler", grund: "anmeldung" });
  });

  it("nimmt «extern» nur als true (USB-Platte), alles andere faellt weg", () => {
    const roh = beispiel();
    (roh.nas as Record<string, unknown>).snmp = {
      status: "ok", quelle: "exporter",
      platten: [
        { schacht: 4, temp_c: 40, gesundheit: "ok", extern: false },
        { schacht: 5, temp_c: 33, gesundheit: "ok", extern: true },
        { schacht: 6, temp_c: 30, extern: "true" },
        { schacht: 7, temp_c: 31, extern: 1 },
      ],
    };
    expect(lies(roh).nas?.snmp.platten).toEqual([
      { schacht: 4, temp_c: 40, gesundheit: "ok" },
      { schacht: 5, temp_c: 33, gesundheit: "ok", extern: true },
      { schacht: 6, temp_c: 30 },
      { schacht: 7, temp_c: 31 },
    ]);
  });
});

describe("Minutenwerte aus ki und nas", () => {
  it("leitet ki-Werte ab, Tempo nur wenn frisch", () => {
    const p = lies({
      ...beispiel(),
      ki: {
        warteschlange: 2,
        geladen: [{ name: "gemma3:4b", instanz: "schnell", groesse_b: 2 * 1024 ** 3, vram_b: 1 }],
        tempo: { tokens_s: 42.5, modell: "gemma3:4b", am: "2026-10-12T05:52:40Z" },
        fsm_antwort_ms: 210,
      },
    });
    expect(kiMinutenwerte(p.ki!, p.gesendet_am)).toEqual({ "ki.warteschlange": 2, "ki.geladen_gb": 2, "ki.tokens_s": 42.5, "ki.fsm_antwort_ms": 210 });
    const alt = { ...p.ki!, tempo: { tokens_s: 42.5, modell: "gemma3:4b", am: "2026-10-12T05:40:00.000Z" } };
    expect(kiMinutenwerte(alt, p.gesendet_am)["ki.tokens_s"]).toBeUndefined();
  });

  it("leitet nas-Werte ab, Hardware nur mit SNMP-Zugang", () => {
    const p = lies(beispiel());
    expect(nasMinutenwerte(p.nas!)).toEqual({ "nas.belegt_prozent": 6.68 });
    const mitSnmp = { ...p.nas!, snmp: { status: "ok" as const, system_temp_c: 44, last_prozent: 12, platten: [{ schacht: 1, temp_c: 36 }, { schacht: 2, temp_c: 39 }] } };
    expect(nasMinutenwerte(mitSnmp)).toEqual({ "nas.belegt_prozent": 6.68, "nas.system_temp": 44, "nas.platte_temp.max": 39, "nas.last": 12 });
  });
});

describe("leiteEreignisseAb", () => {
  const basis = () => lies(beispiel());

  it("erzeugt fuer dasselbe Paket zweimal keine Ereignisse", () => {
    const p = basis();
    expect(leiteEreignisseAb({ rig: p.rig, ki: p.ki }, { rig: p.rig, ki: p.ki })).toEqual([]);
  });

  it("erkennt einen Rig-Neustart und unterdrueckt dann die Dienst-Neustarts", () => {
    const vorher = basis();
    const neu = structuredClone(vorher);
    neu.rig!.uptime_s = 120;
    neu.rig!.dienste![0].gestartet_am = "2026-10-12T05:52:00.000Z";
    const e = leiteEreignisseAb({ rig: vorher.rig }, { rig: neu.rig });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ art: "neustart", stufe: "hinweis", schluessel: "rig.neustart", text: "Rig neu gestartet" });
    expect(e[0].zeitpunkt).toBe("2026-10-12T05:51:04.000Z");
  });

  it("unterscheidet Absturz, Speichermangel und geplanten Neustart", () => {
    const vorher = basis();
    const absturz = structuredClone(vorher);
    absturz.rig!.dienste![0].neustarts = 1;
    expect(leiteEreignisseAb({ rig: vorher.rig }, { rig: absturz.rig })).toEqual([
      expect.objectContaining({ art: "absturz", stufe: "warnung", schluessel: "dienst.ki_dienst", text: "KI-Dienst unerwartet neu gestartet" }),
    ]);

    const oom = structuredClone(absturz);
    oom.rig!.dienste![0].oom = true;
    expect(leiteEreignisseAb({ rig: vorher.rig }, { rig: oom.rig })).toEqual([
      expect.objectContaining({ art: "absturz", stufe: "kritisch", text: "KI-Dienst wegen Speichermangel beendet" }),
    ]);

    const geplant = structuredClone(vorher);
    geplant.rig!.dienste![1].gestartet_am = "2026-10-12T05:53:00.000Z";
    expect(leiteEreignisseAb({ rig: vorher.rig }, { rig: geplant.rig })).toEqual([
      expect.objectContaining({ art: "neustart", stufe: "hinweis", schluessel: "dienst.webserver", text: "Webserver neu gestartet" }),
    ]);
  });

  it("meldet Archiv-Laeufe nur mit Neuem oder Fehlern, Tiefen-Index bei neuem Lauf", () => {
    const vorher = basis();
    const leer = structuredClone(vorher);
    leer.ki!.archiv!.letzter_lauf = "2026-10-12T05:52:13.000Z";
    expect(leiteEreignisseAb({ ki: vorher.ki }, { ki: leer.ki })).toEqual([]);

    const mitNeuem = structuredClone(leer);
    mitNeuem.ki!.archiv!.neu = 3;
    mitNeuem.ki!.tiefen_index!.letzter_lauf = "2026-10-12T05:50:00.000Z";
    expect(leiteEreignisseAb({ ki: vorher.ki }, { ki: mitNeuem.ki })).toEqual([
      expect.objectContaining({ bauteil: "ki", text: "Archiv-Lauf: 3 neu, 0 Fehler, 2,1 s" }),
      expect.objectContaining({ bauteil: "index", text: "Tiefen-Index: 449 von 449 Dateien gelesen" }),
    ]);
  });

  it("vergleicht nichts ohne vorherigen Stand", () => {
    const p = basis();
    const rig: RigPaket = { ...p.rig!, uptime_s: 1 };
    expect(leiteEreignisseAb({}, { rig, ki: p.ki })).toEqual([]);
  });
});

describe("lesePaket: Kuehlung (§2.5)", () => {
  const mitKuehlung = (kuehlung: unknown, minute?: Record<string, unknown>) => {
    const roh = beispiel();
    const r = roh.rig as Record<string, unknown>;
    r.kuehlung = kuehlung;
    if (minute) r.minute = minute;
    return lies(roh).rig;
  };

  it("nimmt das Vertragsbeispiel an, Minutenreihen der Kuehlung inklusive", () => {
    const rig = mitKuehlung(
      {
        status: "ok", profil_aktiv: "ausgewogen",
        luefter: [{ nr: 1, ort: "radiator", rpm: 1234, prozent: 40 }, { nr: 2, ort: "front", rpm: 980.6, prozent: 35 }],
        pumpe_rpm: 2100, pumpe_prozent: 60, kuehlmittel_c: 31.5, leds: "aus",
      },
      { "kuehlung.kuehlmittel_c": 31.42, "kuehlung.pumpe_rpm": 2100, "kuehlung.luefter_rpm": 1107, "kuehlung.fremd": 3 },
    );
    expect(rig?.kuehlung).toEqual({
      status: "ok", profil_aktiv: "ausgewogen",
      luefter: [{ nr: 1, ort: "radiator", rpm: 1234, prozent: 40 }, { nr: 2, ort: "front", rpm: 981, prozent: 35 }],
      pumpe_rpm: 2100, pumpe_prozent: 60, kuehlmittel_c: 31.5, leds: "aus",
    });
    expect(rig?.minute).toEqual({ "kuehlung.kuehlmittel_c": 31.42, "kuehlung.pumpe_rpm": 2100, "kuehlung.luefter_rpm": 1107 });
  });

  it("ohne gueltigen Status faellt der Block weg, das Paket bleibt", () => {
    expect(mitKuehlung({ status: "bestens", pumpe_rpm: 2000 })?.kuehlung).toBeUndefined();
    expect(mitKuehlung({ pumpe_rpm: 2000 })?.kuehlung).toBeUndefined();
    expect(mitKuehlung("ok")?.kuehlung).toBeUndefined();
    expect(mitKuehlung({ status: "nicht_eingerichtet" })?.kuehlung).toEqual({ status: "nicht_eingerichtet" });
  });

  it("verwirft unbekannte Woerter, Fehlertexte und unplausible Zahlen", () => {
    const k = mitKuehlung({
      status: "fehler", grund: "Sensor /dev/hwmon3 fehlt", profil_aktiv: "turbo", leds: "regenbogen",
      pumpe_rpm: -5, pumpe_prozent: 140, kuehlmittel_c: 180, hersteller: "Marke X",
      luefter: [{ nr: 1, ort: "decke", rpm: 99_999, prozent: -3 }, { nr: 2, ort: "heck", rpm: "1200" }],
    })?.kuehlung;
    expect(k).toEqual({
      status: "fehler",
      luefter: [{ nr: 1, ort: "unbekannt", prozent: 0 }, { nr: 2, ort: "heck" }],
      pumpe_prozent: 100,
    });
    expect(JSON.stringify(k)).not.toContain("Marke");
    expect(mitKuehlung({ status: "fehler", grund: "sensor_fehlt" })?.kuehlung?.grund).toBe("sensor_fehlt");
  });

  it("Kuehlung bleibt neben dem Leistungs-Block (§2.6) unberuehrt", () => {
    const roh = beispiel();
    const r = roh.rig as Record<string, unknown>;
    r.kuehlung = { status: "nicht_eingerichtet" };
    r.leistung = leistungBeispiel();
    const rig = lies(roh).rig;
    expect(rig?.kuehlung).toEqual({ status: "nicht_eingerichtet" });
    expect(rig?.leistung?.zeitraeume["30d"]?.gelesen?.dateien).toBe(449);
  });

  it("Luefter: Nummer aus der Lage, doppelte Nummern einmal, hoechstens 12", () => {
    const k = mitKuehlung({
      status: "ok", pumpe_rpm: 2000,
      luefter: [{ ort: "front", rpm: 900 }, { nr: 1, ort: "front", rpm: 950 }, { nr: 0, ort: "front", rpm: 1 }, "kaputt", ...Array.from({ length: 20 }, (_, i) => ({ nr: 10 + i, ort: "boden", rpm: 800 }))],
    })?.kuehlung;
    expect(k?.luefter?.[0]).toEqual({ nr: 1, ort: "front", rpm: 900 });
    expect(k?.luefter?.filter((l) => l.nr === 1)).toHaveLength(1);
    expect(k?.luefter?.some((l) => l.nr === 0)).toBe(false);
    expect(k?.luefter?.length).toBe(9); // 12 gekappt, davon 3 ungueltig/doppelt
  });
});

describe("lesePaket: Leistung der lokalen KI (§2.6)", () => {
  const mitLeistung = (leistung: unknown) => {
    const roh = beispiel();
    (roh.rig as Record<string, unknown>).leistung = leistung;
    return lies(roh).rig?.leistung;
  };

  it("nimmt den Block mit den echten Zahlen an, Selbsttest neueste zuerst", () => {
    const l = mitLeistung(leistungBeispiel());
    expect(l?.stand).toBe("2026-10-12T05:50:00.000Z");
    expect(l?.seit).toBe("2026-10-02T20:50:00.000Z");
    expect(Object.keys(l?.zeitraeume ?? {}).sort()).toEqual(["30d", "7d", "alle"]);
    expect(l?.zeitraeume["7d"]).toEqual({
      auftraege: [
        { art: "nacht_zz", n: 282, ok: 282, median_ms: 3958, max_ms: 13594 },
        { art: "nacht_fristen", n: 73, ok: 73, median_ms: 1854, max_ms: 6740 },
        { art: "nas_suche", n: 41, ok: 41, median_ms: 59, max_ms: 6235 },
        { art: "archiv_frage", n: 2, ok: 2, median_ms: 10233, max_ms: 14157 },
      ],
      gelesen: {
        dateien: 449, mit_text: 395, gescannt: 88, seiten: 668, seiten_max: 80, zeichen_max: 206385, mb_max: 17.5,
        s_seite_text: 0.5, s_seite_gescannt: 1.74, s_datei_median: 0.64, s_datei_max: 105.3,
      },
      fristen_geprueft: { dateien: 395, mit_frist: 73 },
      selbsttest: { laeufe: 3, top1: 0.533, top3: 0.683, top1_ohne_name: 0.4, top3_ohne_name: 0.6, ms_median: 4603 },
    });
    expect(l?.selbsttest?.map((x) => x.am)).toEqual(["2026-10-12T03:37:46.000Z", "2026-10-11T03:38:27.000Z", "2026-10-10T03:42:22.000Z"]);
  });

  it("nimmt Arten nur aus der Weissliste, ok hoechstens n, jede Art einmal, hoechstens 12", () => {
    const l = leistungBeispiel();
    const z = l.zeitraeume as Record<string, Record<string, unknown>>;
    z["7d"].auftraege = [
      { art: "trust_backtest", n: 5, ok: 5 },
      { art: "hg_laden", n: 1, ok: 1, median_ms: 48867 },
      { art: "nas_suche", n: 3, ok: 4 },
      { art: "diktat", n: 4, ok: 4, median_ms: 4066 },
      { art: "diktat", n: 9, ok: 9 },
      { art: "beleg_analyse", n: "2", ok: 2 },
      { art: "archiv_frage", n: 2, ok: 2, median_ms: 90_000_000, max_ms: -1, pfad: "/mnt/eventline-nas/x.pdf" },
    ];
    expect(mitLeistung(l)?.zeitraeume["7d"]?.auftraege).toEqual([
      { art: "diktat", n: 4, ok: 4, median_ms: 4066 },
      { art: "archiv_frage", n: 2, ok: 2 },
    ]);
    z["30d"].auftraege = Array.from({ length: 20 }, () => ({ art: "nas_suche", n: 1, ok: 1 }));
    expect(mitLeistung(l)?.zeitraeume["30d"]?.auftraege).toHaveLength(1);
  });

  it("verwirft Anteile ausserhalb 0…1, Teilmengen groesser als das Ganze und Texte", () => {
    const l = leistungBeispiel();
    const z = l.zeitraeume as Record<string, Record<string, unknown>>;
    z.alle.gelesen = { dateien: 10, mit_text: 12, gescannt: 3, seiten_max: "80", s_seite_text: -1, s_datei_max: 100_000, mb_max: 3.25, name: "Vertrag.pdf" };
    z.alle.selbsttest = { laeufe: 2, top1: 1.2, top3: 0.9, top1_ohne_name: -0.1, ms_median: 4000.6 };
    z.alle.fristen_geprueft = { dateien: 5, mit_frist: 9 };
    const a = mitLeistung(l)?.zeitraeume.alle;
    expect(a?.gelesen).toEqual({ dateien: 10, gescannt: 3, mb_max: 3.3 });
    expect(a?.selbsttest).toEqual({ laeufe: 2, top3: 0.9 });
    expect(a?.fristen_geprueft).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("Vertrag");
  });

  it("ohne Stand oder ohne lesbaren Zeitraum faellt der Block weg; ein kaputter Zeitraum allein faellt weg", () => {
    expect(mitLeistung({ ...leistungBeispiel(), stand: "gestern" })).toBeUndefined();
    expect(mitLeistung({ ...leistungBeispiel(), stand: "2026-10-12T07:00:00Z" })).toBeUndefined(); // > 5 min Zukunft
    expect(mitLeistung({ ...leistungBeispiel(), zeitraeume: { "1y": {} } })).toBeUndefined();
    expect(mitLeistung("viel")).toBeUndefined();
    const l = leistungBeispiel();
    (l.zeitraeume as Record<string, unknown>)["7d"] = { auftraege: "keine" };
    expect(Object.keys(mitLeistung(l)?.zeitraeume ?? {}).sort()).toEqual(["30d", "alle"]);
  });

  it("Selbsttest-Laeufe: ohne Zeit oder Dateizahl verworfen, hoechstens 30", () => {
    const l = leistungBeispiel();
    l.selbsttest = [
      { dateien: 40, top1: 0.5 },
      { am: "2026-10-12T03:00:00Z", top1: 0.5 },
      ...Array.from({ length: 40 }, (_, i) => ({ am: new Date(Date.parse("2026-09-01T03:00:00Z") + i * 86_400_000).toISOString(), dateien: 40, top1: 0.5 })),
    ];
    const laeufe = mitLeistung(l)?.selbsttest ?? [];
    expect(laeufe).toHaveLength(28); // 30 gekappt, 2 ungueltig
    expect(laeufe[0].am > laeufe[laeufe.length - 1].am).toBe(true);
  });
});
