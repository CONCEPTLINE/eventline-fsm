// Leser fuer das Paket vom Rig (POST /api/technik/messwerte, Vertrag §2) und
// die daraus abgeleiteten Minutenwerte und Ereignisse (§2.3, §3 Ingest).
// Rein (kein I/O). Zod gibt es im Projekt nicht — darum handgeschriebene
// Leser im Stil von src/lib/ki/bereinigen.ts.
//
// Grundsatz: Vom Rig kommt nur, was der Vertrag nennt. Fehlende Bloecke und
// Felder sind normal (Sensor fehlt, NAS haengt) und brechen nie ab. Unbekannte
// Felder fallen weg, Zahlen werden auf Plausibilitaetsbereiche geklemmt oder
// verworfen, Strings nur ueber Weisslisten/Regex. Ein kaputter Block faellt
// als Ganzes weg; nur ein falsches `v` oder ein kaputter Rahmen lehnt das
// ganze Paket ab.

import { KI_ARTEN } from "@/lib/ki/konstanten";
import {
  DIENST_ANZEIGE,
  DIENST_NAMEN,
  MINUTEN_SCHLUESSEL_RIG,
  TECHNIK_ARRAY_MAX,
  TECHNIK_BLOCK_MAX_ALTER_MS,
  TECHNIK_ENTLADEN_MAX_ZUKUNFT_MS,
  TECHNIK_PAKET_VERSION,
  TECHNIK_ZUKUNFT_TOLERANZ_MS,
  TEMPO_FRISCH_MS,
} from "./konstanten";
import type { Bauteil, DienstName, Ereignis, Instanz, KiPaket, NasPaket, PaketV1, RigPaket, SnmpGrund } from "./typen";

// ---- Grundbausteine ---------------------------------------------------------

type Roh = Record<string, unknown>;

function istObjekt(x: unknown): x is Roh {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

const MODELL_RE = /^[a-z0-9][a-z0-9._:/-]{0,79}$/i;
const PSTATE_RE = /^P\d{1,2}$/;
const VERSION_RE = /^[0-9][0-9a-z.+-]{0,39}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

const BYTES_MAX = 2 ** 53;
const TEMP_MIN = -20;
const TEMP_MAX = 150;
const KI_ARTEN_SET: ReadonlySet<string> = new Set(KI_ARTEN);
const DIENST_SET: ReadonlySet<string> = new Set(DIENST_NAMEN);
const MINUTEN_RIG_SET: ReadonlySet<string> = new Set(MINUTEN_SCHLUESSEL_RIG);

function endlich(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function runde(n: number, stellen = 2): number {
  const f = 10 ** stellen;
  return Math.round(n * f) / f;
}

/** Temperatur in °C, ausserhalb −20…150 verworfen. */
function temp(x: unknown): number | undefined {
  return endlich(x) && x >= TEMP_MIN && x <= TEMP_MAX ? runde(x, 1) : undefined;
}

/** Prozent: offensichtlicher Unsinn (< −5 oder > 150) verworfen, sonst auf 0…100 geklemmt. */
function prozent(x: unknown): number | undefined {
  if (!endlich(x) || x < -5 || x > 150) return undefined;
  return runde(Math.min(100, Math.max(0, x)), 2);
}

/** Bytes: ganze Zahl 0…2^53. */
function bytes(x: unknown): number | undefined {
  return endlich(x) && x >= 0 && x <= BYTES_MAX ? Math.round(x) : undefined;
}

/** Zaehler/Messwert ≥ 0 bis `max`. */
function zahl(x: unknown, max: number, stellen = 2): number | undefined {
  return endlich(x) && x >= 0 && x <= max ? runde(x, stellen) : undefined;
}

/** Ganze Zahl im Bereich. */
function ganz(x: unknown, min: number, max: number): number | undefined {
  return endlich(x) && Number.isInteger(x) && x >= min && x <= max ? x : undefined;
}

function bool(x: unknown): boolean | undefined {
  return typeof x === "boolean" ? x : undefined;
}

function aus<T extends string>(x: unknown, erlaubt: readonly T[]): T | undefined {
  return typeof x === "string" && (erlaubt as readonly string[]).includes(x) ? (x as T) : undefined;
}

function text(x: unknown, re: RegExp): string | undefined {
  return typeof x === "string" && re.test(x) ? x : undefined;
}

/** Nur definierte Werte uebernehmen (unbekannte/kaputte Felder fallen so weg). */
function setze<T extends object, K extends keyof T>(ziel: T, k: K, v: T[K] | undefined): void {
  if (v !== undefined) ziel[k] = v;
}

function leerWeg<T extends object>(o: T): T | undefined {
  return Object.keys(o).length > 0 ? o : undefined;
}

/** Zeitstempel-Leser mit der Zeit des Empfangs. */
function zeitLeser(jetztMs: number) {
  return (x: unknown, zukunftMs = TECHNIK_ZUKUNFT_TOLERANZ_MS): string | undefined => {
    if (typeof x !== "string" || x.length > 40 || !ISO_RE.test(x)) return undefined;
    const t = Date.parse(x);
    if (!Number.isFinite(t) || t > jetztMs + zukunftMs) return undefined;
    return new Date(t).toISOString();
  };
}

// ---- Bloecke ----------------------------------------------------------------

type Zeit = ReturnType<typeof zeitLeser>;

function leseRig(r: unknown, zeit: Zeit, jetztMs: number): RigPaket | undefined {
  if (!istObjekt(r)) return undefined;
  const gemessen_am = zeit(r.gemessen_am);
  if (!gemessen_am || Date.parse(gemessen_am) < jetztMs - TECHNIK_BLOCK_MAX_ALTER_MS) return undefined;
  const rig: RigPaket = { gemessen_am };
  setze(rig, "uptime_s", ganz(r.uptime_s, 0, 20 * 365 * 86400));

  if (istObjekt(r.cpu)) {
    const c = r.cpu;
    const cpu: NonNullable<RigPaket["cpu"]> = {};
    setze(cpu, "temp_c", temp(c.temp_c));
    setze(cpu, "temp_c_5min", temp(c.temp_c_5min));
    setze(cpu, "temp_c_max_1min", temp(c.temp_c_max_1min));
    if (Array.isArray(c.kerne_temp_c) && c.kerne_temp_c.length === 2) {
      const a = temp(c.kerne_temp_c[0]);
      const b = temp(c.kerne_temp_c[1]);
      if (a !== undefined && b !== undefined) cpu.kerne_temp_c = [a, b];
    }
    setze(cpu, "chipsatz_temp_c", temp(c.chipsatz_temp_c));
    setze(cpu, "last_prozent", prozent(c.last_prozent));
    setze(cpu, "last_prozent_5min", prozent(c.last_prozent_5min));
    setze(cpu, "last_prozent_10min", prozent(c.last_prozent_10min));
    setze(cpu, "takt_mhz", zahl(c.takt_mhz, 20_000, 0));
    setze(cpu, "takt_mhz_max_kern", zahl(c.takt_mhz_max_kern, 20_000, 0));
    setze(cpu, "kerne", ganz(c.kerne, 1, 1024));
    setze(cpu, "threads", ganz(c.threads, 1, 4096));
    setze(cpu, "drosselung", bool(c.drosselung));
    if (c.luefter_rpm === null) cpu.luefter_rpm = null;
    else if (Array.isArray(c.luefter_rpm)) {
      cpu.luefter_rpm = c.luefter_rpm
        .slice(0, TECHNIK_ARRAY_MAX.luefter_rpm)
        .map((x) => zahl(x, 30_000, 0))
        .filter((x): x is number => x !== undefined);
    }
    if (istObjekt(c.anteil_kerne)) {
      const anteil: NonNullable<NonNullable<RigPaket["cpu"]>["anteil_kerne"]> = {};
      setze(anteil, "ki", zahl(c.anteil_kerne.ki, 4096));
      setze(anteil, "trustone", zahl(c.anteil_kerne.trustone, 4096));
      setze(cpu, "anteil_kerne", leerWeg(anteil));
    }
    setze(rig, "cpu", leerWeg(cpu));
  }

  if (istObjekt(r.gpu)) {
    const g = r.gpu;
    const gpu: NonNullable<RigPaket["gpu"]> = {};
    setze(gpu, "temp_c", temp(g.temp_c));
    setze(gpu, "temp_c_max_1min", temp(g.temp_c_max_1min));
    setze(gpu, "last_prozent", prozent(g.last_prozent));
    setze(gpu, "vram_belegt_mib", zahl(g.vram_belegt_mib, 1_048_576, 0));
    setze(gpu, "vram_gesamt_mib", zahl(g.vram_gesamt_mib, 1_048_576, 0));
    setze(gpu, "watt", zahl(g.watt, 5000, 1));
    setze(gpu, "watt_grenze", zahl(g.watt_grenze, 5000, 1));
    setze(gpu, "luefter_prozent", prozent(g.luefter_prozent));
    setze(gpu, "pstate", text(g.pstate, PSTATE_RE));
    setze(gpu, "treiber", text(g.treiber, VERSION_RE));
    setze(gpu, "takt_mhz", zahl(g.takt_mhz, 20_000, 0));
    setze(gpu, "takt_max_mhz", zahl(g.takt_max_mhz, 20_000, 0));
    setze(rig, "gpu", leerWeg(gpu));
  }

  if (istObjekt(r.ram)) {
    const m = r.ram;
    const ram: NonNullable<RigPaket["ram"]> = {};
    setze(ram, "eingebaut_gb", zahl(m.eingebaut_gb, 65_536, 1));
    if (Array.isArray(m.module)) {
      const gesehen = new Set<number>();
      const riegel: NonNullable<NonNullable<RigPaket["ram"]>["module"]> = [];
      for (const roh of m.module.slice(0, TECHNIK_ARRAY_MAX.module)) {
        if (!istObjekt(roh)) continue;
        const platz = ganz(roh.platz, 1, 64);
        const groesse_gb = zahl(roh.groesse_gb, 4096, 1);
        if (platz === undefined || groesse_gb === undefined || gesehen.has(platz)) continue;
        gesehen.add(platz);
        const modul: (typeof riegel)[number] = { platz, groesse_gb };
        if (roh.temp_c === null) modul.temp_c = null;
        else setze(modul, "temp_c", temp(roh.temp_c));
        riegel.push(modul);
      }
      ram.module = riegel;
    }
    setze(ram, "gesamt_b", bytes(m.gesamt_b));
    setze(ram, "verfuegbar_b", bytes(m.verfuegbar_b));
    setze(ram, "frei_b", bytes(m.frei_b));
    setze(ram, "swap_gesamt_b", bytes(m.swap_gesamt_b));
    setze(ram, "swap_belegt_b", bytes(m.swap_belegt_b));
    setze(ram, "psi_full_avg10", prozent(m.psi_full_avg10));
    setze(ram, "psi_some_avg10", prozent(m.psi_some_avg10));
    setze(ram, "seitenfehler_s", zahl(m.seitenfehler_s, 1e9, 1));
    if (istObjekt(m.ki)) {
      const ki: NonNullable<NonNullable<RigPaket["ram"]>["ki"]> = {};
      setze(ki, "belegt_b", bytes(m.ki.belegt_b));
      setze(ki, "fest_b", bytes(m.ki.fest_b));
      setze(ki, "cache_b", bytes(m.ki.cache_b));
      setze(ki, "grenze_b", bytes(m.ki.grenze_b));
      setze(ki, "swap_b", bytes(m.ki.swap_b));
      setze(ram, "ki", leerWeg(ki));
    }
    if (istObjekt(m.trustone)) {
      const t1: NonNullable<NonNullable<RigPaket["ram"]>["trustone"]> = {};
      setze(t1, "summe_b", bytes(m.trustone.summe_b));
      setze(t1, "grenze_hoch_b", bytes(m.trustone.grenze_hoch_b));
      setze(t1, "grenze_max_b", bytes(m.trustone.grenze_max_b));
      setze(ram, "trustone", leerWeg(t1));
    }
    setze(rig, "ram", leerWeg(ram));
  }

  if (istObjekt(r.platten)) {
    const p = r.platten;
    const platten: NonNullable<RigPaket["platten"]> = {};
    const belegung = (x: unknown) => {
      if (!istObjekt(x)) return undefined;
      const gesamt_b = bytes(x.gesamt_b);
      const belegt_b = bytes(x.belegt_b);
      return gesamt_b !== undefined && belegt_b !== undefined && gesamt_b > 0 && belegt_b <= gesamt_b
        ? { gesamt_b, belegt_b }
        : undefined;
    };
    setze(platten, "system", belegung(p.system));
    setze(platten, "tresor", belegung(p.tresor));
    if (istObjekt(p.ssd)) {
      const status = aus(p.ssd.status, ["ok", "nicht_verfuegbar"] as const);
      if (status) {
        const ssd: NonNullable<NonNullable<RigPaket["platten"]>["ssd"]> = { status };
        if (status === "ok") {
          ssd.temp_c = p.ssd.temp_c === null ? null : (temp(p.ssd.temp_c) ?? null);
          ssd.gesundheit = aus(p.ssd.gesundheit, ["ok", "warnung", "fehler"] as const) ?? null;
          ssd.abnutzung_prozent = p.ssd.abnutzung_prozent === null ? null : (prozent(p.ssd.abnutzung_prozent) ?? null);
          ssd.betriebsstunden = p.ssd.betriebsstunden === null ? null : (ganz(p.ssd.betriebsstunden, 0, 2_000_000) ?? null);
        }
        platten.ssd = ssd;
      }
    }
    setze(rig, "platten", leerWeg(platten));
  }

  if (istObjekt(r.io)) {
    const i = r.io;
    const io: NonNullable<RigPaket["io"]> = {};
    setze(io, "gelesen_b", bytes(i.gelesen_b));
    setze(io, "geschrieben_b", bytes(i.geschrieben_b));
    setze(io, "netz_rx_b", bytes(i.netz_rx_b));
    setze(io, "netz_tx_b", bytes(i.netz_tx_b));
    setze(io, "vpn_rx_b", bytes(i.vpn_rx_b));
    setze(io, "vpn_tx_b", bytes(i.vpn_tx_b));
    setze(rig, "io", leerWeg(io));
  }

  if (Array.isArray(r.dienste)) {
    const gesehen = new Set<string>();
    const dienste: NonNullable<RigPaket["dienste"]> = [];
    for (const roh of r.dienste.slice(0, TECHNIK_ARRAY_MAX.dienste)) {
      if (!istObjekt(roh)) continue;
      const name = typeof roh.name === "string" && DIENST_SET.has(roh.name) ? (roh.name as DienstName) : undefined;
      const zustand = aus(roh.zustand, ["laeuft", "startet", "neustart", "gestoppt"] as const);
      if (!name || !zustand || gesehen.has(name)) continue;
      gesehen.add(name);
      const d: (typeof dienste)[number] = { name, zustand, gesund: typeof roh.gesund === "boolean" ? roh.gesund : null };
      setze(d, "gestartet_am", zeit(roh.gestartet_am));
      setze(d, "neustarts", ganz(roh.neustarts, 0, 1_000_000));
      setze(d, "oom", bool(roh.oom));
      setze(d, "speicher_b", bytes(roh.speicher_b));
      if (roh.grenze_b === null) d.grenze_b = null;
      else setze(d, "grenze_b", bytes(roh.grenze_b));
      dienste.push(d);
    }
    rig.dienste = dienste;
  }

  if (istObjekt(r.minute)) {
    const minute: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.minute)) {
      if (MINUTEN_RIG_SET.has(k) && endlich(v) && Math.abs(v) <= 1e15) minute[k] = runde(v, 3);
    }
    setze(rig, "minute", leerWeg(minute));
  }

  return rig;
}

const INSTANZEN = ["schnell", "gruendlich"] as const satisfies readonly Instanz[];
const SCHALTER = ["suche", "archiv_frage", "hintergrund", "lernen", "tiefe", "hauptmodell"] as const;

function leseKi(k: unknown, zeit: Zeit): KiPaket | undefined {
  if (!istObjekt(k)) return undefined;
  const ki: KiPaket = {};
  setze(ki, "version", text(k.version, VERSION_RE));
  setze(ki, "eingestellt", text(k.eingestellt, MODELL_RE));

  if (Array.isArray(k.instanzen)) {
    const gesehen = new Set<string>();
    const instanzen: NonNullable<KiPaket["instanzen"]> = [];
    for (const roh of k.instanzen.slice(0, TECHNIK_ARRAY_MAX.instanzen)) {
      if (!istObjekt(roh)) continue;
      const name = aus(roh.name, INSTANZEN);
      const erreichbar = bool(roh.erreichbar);
      if (!name || erreichbar === undefined || gesehen.has(name)) continue;
      gesehen.add(name);
      const i: (typeof instanzen)[number] = { name, erreichbar };
      setze(i, "version", text(roh.version, VERSION_RE));
      setze(i, "grenze_b", bytes(roh.grenze_b));
      instanzen.push(i);
    }
    ki.instanzen = instanzen;
  }

  if (Array.isArray(k.modelle)) {
    const modelle: NonNullable<KiPaket["modelle"]> = [];
    for (const roh of k.modelle.slice(0, TECHNIK_ARRAY_MAX.modelle)) {
      if (!istObjekt(roh)) continue;
      const name = text(roh.name, MODELL_RE);
      const groesse_b = bytes(roh.groesse_b);
      if (name && groesse_b !== undefined) modelle.push({ name, groesse_b });
    }
    ki.modelle = modelle;
  }

  if (Array.isArray(k.geladen)) {
    const geladen: NonNullable<KiPaket["geladen"]> = [];
    for (const roh of k.geladen.slice(0, TECHNIK_ARRAY_MAX.geladen)) {
      if (!istObjekt(roh)) continue;
      const name = text(roh.name, MODELL_RE);
      const instanz = aus(roh.instanz, INSTANZEN);
      const groesse_b = bytes(roh.groesse_b);
      const vram_b = bytes(roh.vram_b);
      if (!name || !instanz || groesse_b === undefined || vram_b === undefined) continue;
      const g: (typeof geladen)[number] = { name, instanz, groesse_b, vram_b };
      setze(g, "entlaedt_am", zeit(roh.entlaedt_am, TECHNIK_ENTLADEN_MAX_ZUKUNFT_MS));
      geladen.push(g);
    }
    ki.geladen = geladen;
  }

  if (k.auftrag === null) ki.auftrag = null;
  else if (istObjekt(k.auftrag)) {
    const art = typeof k.auftrag.art === "string" && KI_ARTEN_SET.has(k.auftrag.art) ? k.auftrag.art : undefined;
    const seit = zeit(k.auftrag.seit);
    if (art && seit) {
      const auftrag: NonNullable<KiPaket["auftrag"]> = { art, seit };
      setze(auftrag, "modell", text(k.auftrag.modell, MODELL_RE));
      ki.auftrag = auftrag;
    }
  }

  setze(ki, "warteschlange", ganz(k.warteschlange, 0, 1_000_000));

  if (k.tempo === null) ki.tempo = null;
  else if (istObjekt(k.tempo)) {
    const tokens_s = zahl(k.tempo.tokens_s, 100_000, 1);
    const modell = text(k.tempo.modell, MODELL_RE);
    const am = zeit(k.tempo.am);
    if (tokens_s !== undefined && modell && am) ki.tempo = { tokens_s, modell, am };
  }

  if (istObjekt(k.archiv)) {
    const a = k.archiv;
    const archiv: NonNullable<KiPaket["archiv"]> = {};
    setze(archiv, "anzahl", ganz(a.anzahl, 0, 1e9));
    setze(archiv, "letzter_lauf", zeit(a.letzter_lauf));
    setze(archiv, "neu", ganz(a.neu, 0, 1e9));
    setze(archiv, "fehler", ganz(a.fehler, 0, 1e9));
    setze(archiv, "dauer_s", zahl(a.dauer_s, 30 * 86400, 1));
    setze(ki, "archiv", leerWeg(archiv));
  }

  if (istObjekt(k.tiefen_index)) {
    const t = k.tiefen_index;
    const tiefe: NonNullable<KiPaket["tiefen_index"]> = {};
    setze(tiefe, "dateien", ganz(t.dateien, 0, 1e9));
    setze(tiefe, "nas_dateien", ganz(t.nas_dateien, 0, 1e9));
    setze(tiefe, "mit_text", ganz(t.mit_text, 0, 1e9));
    setze(tiefe, "abschnitte", ganz(t.abschnitte, 0, 1e10));
    setze(tiefe, "letzter_lauf", zeit(t.letzter_lauf));
    setze(tiefe, "nacht_fertig", bool(t.nacht_fertig));
    setze(ki, "tiefen_index", leerWeg(tiefe));
  }

  if (istObjekt(k.schalter)) {
    const schalter: NonNullable<KiPaket["schalter"]> = {};
    for (const s of SCHALTER) setze(schalter, s, bool(k.schalter[s]));
    setze(ki, "schalter", leerWeg(schalter));
  }

  setze(ki, "hauptmodell_geladen", bool(k.hauptmodell_geladen));
  if (k.fsm_antwort_ms === null) ki.fsm_antwort_ms = null;
  else setze(ki, "fsm_antwort_ms", zahl(k.fsm_antwort_ms, 600_000, 0));
  setze(ki, "fsm_fehler_in_folge", ganz(k.fsm_fehler_in_folge, 0, 1e9));
  return ki;
}

const SNMP_GRUENDE = ["zeitlimit", "anmeldung", "keine_antwort", "werkzeug_fehlt", "zugang_ungueltig", "unbekannt"] as const satisfies readonly SnmpGrund[];

function leseNas(n: unknown, zeit: Zeit, jetztMs: number): NasPaket | undefined {
  if (!istObjekt(n)) return undefined;
  const gemessen_am = zeit(n.gemessen_am);
  const erreichbar = bool(n.erreichbar);
  const fehlversuche = ganz(n.fehlversuche_in_folge, 0, 1e9);
  if (!gemessen_am || erreichbar === undefined || fehlversuche === undefined) return undefined;
  if (Date.parse(gemessen_am) < jetztMs - TECHNIK_BLOCK_MAX_ALTER_MS) return undefined;

  const snmp: NasPaket["snmp"] = { status: "nicht_eingerichtet" };
  if (istObjekt(n.snmp)) {
    const s = n.snmp;
    const status = aus(s.status, ["nicht_eingerichtet", "ok", "fehler"] as const);
    if (status) snmp.status = status;
    setze(snmp, "grund", aus(s.grund, SNMP_GRUENDE));
    setze(snmp, "gemessen_am", zeit(s.gemessen_am));
    if (snmp.status === "ok") {
      setze(snmp, "system_temp_c", temp(s.system_temp_c));
      setze(snmp, "cpu_temp_c", temp(s.cpu_temp_c));
      if (Array.isArray(s.platten)) {
        const gesehen = new Set<number>();
        const platten: NonNullable<NasPaket["snmp"]["platten"]> = [];
        for (const roh of s.platten.slice(0, TECHNIK_ARRAY_MAX.platten)) {
          if (!istObjekt(roh)) continue;
          const schacht = ganz(roh.schacht, 1, 64);
          if (schacht === undefined || gesehen.has(schacht)) continue;
          gesehen.add(schacht);
          const p: (typeof platten)[number] = { schacht };
          setze(p, "temp_c", temp(roh.temp_c));
          setze(p, "gesundheit", aus(roh.gesundheit, ["ok", "warnung", "fehler"] as const));
          platten.push(p);
        }
        snmp.platten = platten;
      }
      if (s.raid === null) snmp.raid = null;
      else setze(snmp, "raid", aus(s.raid, ["normal", "wiederaufbau", "degradiert"] as const));
      setze(snmp, "last_prozent", prozent(s.last_prozent));
      setze(snmp, "ram_prozent", prozent(s.ram_prozent));
      setze(snmp, "uptime_s", ganz(s.uptime_s, 0, 20 * 365 * 86400));
    }
  }

  const nas: NasPaket = { gemessen_am, erreichbar, fehlversuche_in_folge: fehlversuche, snmp };
  setze(nas, "dateifreigabe", bool(n.dateifreigabe));
  setze(nas, "weboberflaeche", bool(n.weboberflaeche));
  if (n.volume === null) nas.volume = null;
  else if (istObjekt(n.volume)) {
    const gesamt_b = bytes(n.volume.gesamt_b);
    const belegt_b = bytes(n.volume.belegt_b);
    if (gesamt_b !== undefined && belegt_b !== undefined && gesamt_b > 0 && belegt_b <= gesamt_b) {
      nas.volume = { gesamt_b, belegt_b };
    }
  }
  if (istObjekt(n.freigaben)) {
    const f = n.freigaben;
    const ist = ganz(f.ist, 0, 1000);
    const soll = f.soll === null ? null : ganz(f.soll, 0, 1000);
    if (ist !== undefined && soll !== undefined) {
      const freigaben: NonNullable<NasPaket["freigaben"]> = { soll, ist };
      setze(freigaben, "schreibend", ganz(f.schreibend, 0, 1000));
      setze(freigaben, "lesend", ganz(f.lesend, 0, 1000));
      if (f.fehlt_seit === null) freigaben.fehlt_seit = null;
      else setze(freigaben, "fehlt_seit", zeit(f.fehlt_seit));
      nas.freigaben = freigaben;
    }
  }
  return nas;
}

// ---- Paket ------------------------------------------------------------------

/** Liest ein Paket vom Rig. Fehler nur bei kaputtem Rahmen; kaputte Bloecke fallen still weg. */
export function lesePaket(roh: unknown, jetztMs: number = Date.now()): { paket: PaketV1 } | { fehler: string } {
  if (!istObjekt(roh)) return { fehler: "format" };
  if (roh.v !== TECHNIK_PAKET_VERSION) return { fehler: "version" };
  const zeit = zeitLeser(jetztMs);
  const gesendet_am = zeit(roh.gesendet_am);
  if (!gesendet_am) return { fehler: "gesendet_am" };
  const paket: PaketV1 = { v: 1, gesendet_am };
  setze(paket, "rig", leseRig(roh.rig, zeit, jetztMs));
  setze(paket, "ki", leseKi(roh.ki, zeit));
  setze(paket, "nas", leseNas(roh.nas, zeit, jetztMs));
  return { paket };
}

// ---- Minutenwerte (§2.3) ----------------------------------------------------

const GIB = 1024 ** 3;

/** Minutenwerte, die das FSM aus dem Block `ki` ableitet. */
export function kiMinutenwerte(ki: KiPaket, gesendetAm: string): Record<string, number> {
  const w: Record<string, number> = {};
  if (ki.warteschlange !== undefined) w["ki.warteschlange"] = ki.warteschlange;
  if (ki.geladen) w["ki.geladen_gb"] = runde(ki.geladen.reduce((s, g) => s + g.groesse_b, 0) / GIB, 2);
  if (ki.tempo && Math.abs(Date.parse(gesendetAm) - Date.parse(ki.tempo.am)) <= TEMPO_FRISCH_MS) {
    w["ki.tokens_s"] = ki.tempo.tokens_s;
  }
  if (typeof ki.fsm_antwort_ms === "number") w["ki.fsm_antwort_ms"] = ki.fsm_antwort_ms;
  return w;
}

/** Minutenwerte, die das FSM aus dem Block `nas` ableitet (Hardware nur mit SNMP-Zugang). */
export function nasMinutenwerte(nas: NasPaket): Record<string, number> {
  const w: Record<string, number> = {};
  if (nas.volume && nas.volume.gesamt_b > 0) {
    w["nas.belegt_prozent"] = runde((nas.volume.belegt_b / nas.volume.gesamt_b) * 100, 2);
  }
  if (nas.snmp.status === "ok") {
    if (nas.snmp.system_temp_c !== undefined) w["nas.system_temp"] = nas.snmp.system_temp_c;
    const temps = (nas.snmp.platten ?? []).map((p) => p.temp_c).filter((t): t is number => t !== undefined);
    if (temps.length > 0) w["nas.platte_temp.max"] = Math.max(...temps);
    if (nas.snmp.last_prozent !== undefined) w["nas.last"] = nas.snmp.last_prozent;
  }
  return w;
}

// ---- Ereignisse aus dem Vergleich vorher/neu (§3 Ingest, Schritt 4) ---------

export interface NeuesEreignis {
  zeitpunkt: string;
  art: Ereignis["art"];
  stufe: "gut" | "warnung" | "kritisch" | "hinweis";
  bauteil: Bauteil | null;
  schluessel: string | null;
  text: string;
}

export interface VorherStand {
  rig?: RigPaket | null;
  ki?: KiPaket | null;
}

function zahlDe(n: number, stellen: number): string {
  return n.toFixed(stellen).replace(".", ",");
}

/** Leitet Ereignisse aus dem Vergleich mit dem vorherigen Stand ab. Texte nur aus
 *  Vorlagen und Zahlen — nie Text vom Rig. Gleiches Paket zweimal = keine Ereignisse. */
export function leiteEreignisseAb(vorher: VorherStand, neu: { rig?: RigPaket; ki?: KiPaket }): NeuesEreignis[] {
  const aus: NeuesEreignis[] = [];
  const vRig = vorher.rig ?? null;
  const nRig = neu.rig ?? null;

  let rigNeustart = false;
  if (vRig && nRig && vRig.uptime_s !== undefined && nRig.uptime_s !== undefined && nRig.uptime_s < vRig.uptime_s) {
    rigNeustart = true;
    aus.push({
      zeitpunkt: new Date(Date.parse(nRig.gemessen_am) - nRig.uptime_s * 1000).toISOString(),
      art: "neustart",
      stufe: "hinweis",
      bauteil: null,
      schluessel: "rig.neustart",
      text: "Rig neu gestartet",
    });
  }

  if (vRig?.dienste && nRig?.dienste) {
    const alt = new Map(vRig.dienste.map((d) => [d.name, d]));
    for (const d of nRig.dienste) {
      const v = alt.get(d.name);
      if (!v) continue; // erstmals gesehen: kein Vergleich moeglich
      const name = DIENST_ANZEIGE[d.name];
      const schluessel = `dienst.${d.name}`;
      const zeitpunkt = d.gestartet_am ?? nRig.gemessen_am;
      const neustartsGestiegen = d.neustarts !== undefined && v.neustarts !== undefined && d.neustarts > v.neustarts;
      if (d.oom === true && v.oom !== true) {
        aus.push({ zeitpunkt, art: "absturz", stufe: "kritisch", bauteil: "dienste", schluessel, text: `${name} wegen Speichermangel beendet` });
      } else if (neustartsGestiegen) {
        aus.push({ zeitpunkt, art: "absturz", stufe: "warnung", bauteil: "dienste", schluessel, text: `${name} unerwartet neu gestartet` });
      } else if (d.gestartet_am && v.gestartet_am && d.gestartet_am !== v.gestartet_am && !rigNeustart) {
        aus.push({ zeitpunkt, art: "neustart", stufe: "hinweis", bauteil: "dienste", schluessel, text: `${name} neu gestartet` });
      }
    }
  }

  const vKi = vorher.ki ?? null;
  const nKi = neu.ki ?? null;
  // Archiv-Laeufe kommen bis zu alle 30 s: nur Laeufe mit Neuem oder Fehlern sind
  // ein Ereignis, sonst ertraenke die Liste in Leerlaeufen.
  const archiv = nKi?.archiv;
  if (vKi && archiv?.letzter_lauf && archiv.letzter_lauf !== vKi.archiv?.letzter_lauf && ((archiv.neu ?? 0) > 0 || (archiv.fehler ?? 0) > 0)) {
    aus.push({
      zeitpunkt: archiv.letzter_lauf,
      art: "hinweis",
      stufe: "hinweis",
      bauteil: "ki",
      schluessel: "ki.archiv",
      text: `Archiv-Lauf: ${archiv.neu ?? 0} neu, ${archiv.fehler ?? 0} Fehler${archiv.dauer_s !== undefined ? `, ${zahlDe(archiv.dauer_s, 1)} s` : ""}`,
    });
  }
  const tiefe = nKi?.tiefen_index;
  if (vKi && tiefe?.letzter_lauf && tiefe.letzter_lauf !== vKi.tiefen_index?.letzter_lauf) {
    aus.push({
      zeitpunkt: tiefe.letzter_lauf,
      art: "hinweis",
      stufe: "hinweis",
      bauteil: "index",
      schluessel: "ki.tiefen_index",
      text: `Tiefen-Index: ${tiefe.dateien ?? 0} von ${tiefe.nas_dateien ?? 0} Dateien gelesen`,
    });
  }
  return aus;
}
