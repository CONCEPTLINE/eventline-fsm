// Ampel-Regeln des Technik-Dashboards (Vertrag §4, spec.md §3). Reine
// Funktion: dieselbe Bewertung nutzen GET /api/technik/stand und der Cron
// technik-alarme — es gibt keine zweite Logik.
//
// Grundsaetze: Gesamt = schlechteste nicht-neutrale Stufe. Temperatur/Last:
// bewertet werden 5-Minuten-Mittel und Minuten-Spitze; einzelne Spitzen
// darunter nur als Hinweis im Text. Hysterese gegen Flattern (konstanten.ts).
// Veraltete Messwerte werden neutral und alarmieren nie. Texte sind Klartext
// ohne Marken, Adressen oder Geraetenamen.

import { formatTime } from "@/lib/format";
import {
  CPU_TEMP,
  DIENST_ANZEIGE,
  DIENST_NAMEN,
  FSM_FEHLER_KRITISCH,
  GRENZEN,
  NAS_VERALTET_MS,
  ZEIT_GRENZEN_MS,
  plattenName,
  type Grenze,
} from "./konstanten";
import type { Ampel, Bauteil, DienstName, FsmStand, Kachel, KiPaket, NasPaket, NeutralArt, RigPaket, Stufe } from "./typen";

// ---- Anzeige-Helfer (de-CH, Zeiten Europe/Zurich) -----------------------------

const TZ = "Europe/Zurich";
const GIB = 1024 ** 3;

/** Zahl mit Komma als Dezimalzeichen und Schweizer Tausender-Apostroph («1’234,5»). */
export function zahlDe(n: number, stellen = 0): string {
  return new Intl.NumberFormat("de-CH", { minimumFractionDigits: stellen, maximumFractionDigits: stellen })
    .format(n)
    .replace(/\./g, ",");
}

export function grad(n: number): string {
  return `${zahlDe(Math.round(n))} °C`;
}

/** Arbeitsspeicher binaer, beschriftet «GB» (Vertrag §6.4). */
export function gbBinaer(b: number, stellen = 1): string {
  return `${zahlDe(b / GIB, stellen)} GB`;
}

/** Platten/NAS dezimal wie die Hersteller zaehlen: «533 GB», «8,0 TB». */
export function groesseDezimal(b: number): string {
  if (b >= 1e12) return `${zahlDe(b / 1e12, 1)} TB`;
  return `${zahlDe(b / 1e9, 0)} GB`;
}

/** Dauer kurz: «45 s», «4 min», «3 h», «8 Tage». */
export function dauer(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 Tag" : `${d} Tage`;
}

/** «vor 4 min», «vor 8 Tagen». */
export function vorDauer(ms: number): string {
  const d = dauer(ms);
  return `vor ${d.endsWith(" Tage") ? `${d}n` : d}`;
}

/** «21:36» (Europe/Zurich). */
export function uhrzeit(iso: string): string {
  return formatTime(iso);
}

const TAG_MONAT = new Intl.DateTimeFormat("de-CH", { timeZone: TZ, day: "2-digit", month: "2-digit" });

/** «03.10., 03:00» (Europe/Zurich). */
export function datumZeit(iso: string): string {
  const tag = TAG_MONAT.format(new Date(iso));
  return `${tag.endsWith(".") ? tag : `${tag}.`}, ${uhrzeit(iso)}`;
}

export const STUFE_WORT: Readonly<Record<Stufe, string>> = {
  gut: "Gut",
  warnung: "Warnung",
  kritisch: "Kritisch",
  neutral: "Neutral",
};

export const NEUTRAL_WORT: Readonly<Record<NeutralArt, string>> = {
  kommt: "kommt",
  ruht: "Ruht",
  soll_offen: "Soll offen",
  veraltet: "veraltet",
  info: "Info",
  nie_gemeldet: "nie gemeldet",
  nicht_lesbar: "nicht lesbar",
};

export const RANG: Readonly<Record<Stufe, number>> = { neutral: 0, gut: 1, warnung: 2, kritisch: 3 };

// ---- Stufen-Rechner -----------------------------------------------------------

type Bewertet = "gut" | "warnung" | "kritisch";

/** Stufe nach einer Grenze mit Hysterese gegen die vorherige Stufe. */
export function stufeNachGrenze(wert: number, g: Grenze, vorher?: Stufe): Bewertet {
  const hk = vorher === "kritisch" ? g.hysterese : 0;
  const hw = vorher === "warnung" || vorher === "kritisch" ? g.hysterese : 0;
  if (g.richtung === "hoch") {
    if (wert > g.kritisch - hk) return "kritisch";
    if (wert >= g.warnung - hw) return "warnung";
    return "gut";
  }
  if (wert < g.kritisch + hk) return "kritisch";
  if (wert <= g.warnung + hw) return "warnung";
  return "gut";
}

/** Stufe nach Alter (ohne Hysterese): Warnung ab `warnung`, kritisch ueber `kritisch`. */
export function stufeNachAlter(alterMs: number, g: { warnung: number; kritisch: number }): Bewertet {
  if (alterMs > g.kritisch) return "kritisch";
  if (alterMs >= g.warnung) return "warnung";
  return "gut";
}

// ---- Bewertung ----------------------------------------------------------------

export interface AmpelEingabe {
  jetzt: Date;
  rig: RigPaket | null;
  ki: KiPaket | null;
  nas: NasPaket | null;
  fsm: FsmStand;
  abstuerze24h: Partial<Record<DienstName, number>>;
  vorher: Record<string, Stufe>;
  /** Wann der Block `ki` zuletzt kam (technik_stand). Fehlt er, gilt der Block als frisch. */
  ki_gemessen_am?: string | null;
}

interface Basis {
  schluessel: string;
  bauteil: Bauteil;
  kachel: Kachel | null;
  titel: string;
  alarm: boolean;
}

function mach(b: Basis, stufe: Stufe, wert: string | null, text: string, neutral?: NeutralArt): Ampel {
  const a: Ampel = { schluessel: b.schluessel, bauteil: b.bauteil, kachel: b.kachel, stufe, titel: b.titel, wert, text, seit: null, alarm: b.alarm };
  if (stufe === "neutral") {
    a.neutral = neutral ?? "info";
    a.alarm = false;
  }
  return a;
}

const nichtLesbar = (b: Basis) => mach(b, "neutral", null, "Dieser Wert ist nicht lesbar.", "nicht_lesbar");

/** Text fuer einen Messwert mit Grenze, je nach Stufe. */
function grenzText(stufe: Bewertet, gut: string, schlecht: string, g: Grenze, einheit = g.einheit): string {
  if (stufe === "gut") return gut;
  const grenze = stufe === "kritisch" ? g.kritisch : g.warnung;
  const wort = g.richtung === "hoch" ? (stufe === "kritisch" ? "kritisch über" : "Warnung ab") : (stufe === "kritisch" ? "kritisch unter" : "Warnung ab");
  return `${schlecht}, ${wort} ${zahlDe(grenze)}${einheit ? ` ${einheit}` : ""}.`;
}

function prozentVon(teil: number, ganzes: number): number {
  return ganzes > 0 ? (teil / ganzes) * 100 : 0;
}

// -- App/Verbindung --

function verbindungOnline(e: AmpelEingabe, jetztMs: number): Ampel {
  const b: Basis = { schluessel: "verbindung.online", bauteil: "app", kachel: "verbindung", titel: "Rig online", alarm: true };
  const poll = e.fsm.ki_letzter_poll;
  if (!poll) return mach(b, "neutral", null, "Das Rig hat sich noch nie gemeldet.", "nie_gemeldet");
  const alter = jetztMs - Date.parse(poll);
  const stufe = stufeNachAlter(alter, ZEIT_GRENZEN_MS["verbindung.online"]);
  return stufe === "gut"
    ? mach(b, stufe, "online", `Letzter Kontakt ${vorDauer(alter)}.`)
    : mach(b, stufe, vorDauer(alter), `Kein Kontakt zum Rig seit ${dauer(alter)}.`);
}

function messwerteFrische(e: AmpelEingabe, jetztMs: number, onlineGut: boolean): Ampel {
  const b: Basis = { schluessel: "messwerte.frische", bauteil: "app", kachel: "messwerte", titel: "Messwerte aktuell", alarm: onlineGut };
  if (!e.rig) {
    // Vor dem ersten Paket kein Alarm (Vertrag §8, Schritt 2).
    return mach({ ...b, alarm: false }, "kritisch", "nie", "Vom Rig sind noch nie Messwerte angekommen.");
  }
  const alter = jetztMs - Date.parse(e.rig.gemessen_am);
  const stufe = stufeNachAlter(alter, ZEIT_GRENZEN_MS["messwerte.frische"]);
  return stufe === "gut"
    ? mach(b, stufe, "aktuell", `Letzte Messung um ${uhrzeit(e.rig.gemessen_am)}.`)
    : mach(b, stufe, vorDauer(alter), `Seit ${dauer(alter)} keine neuen Messwerte vom Rig (letzte um ${uhrzeit(e.rig.gemessen_am)}).`);
}

function verbindungAntwortzeit(ki: KiPaket | null, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "verbindung.antwortzeit", bauteil: "app", kachel: "verbindung", titel: "Verbindung FSM", alarm: false };
  if (!ki) return nichtLesbar(b);
  const fehler = ki.fsm_fehler_in_folge ?? 0;
  const ms = ki.fsm_antwort_ms;
  if (fehler >= FSM_FEHLER_KRITISCH) {
    return mach(b, "kritisch", typeof ms === "number" ? `${zahlDe(ms / 1000, 2)} s` : null, `${fehler} Messpakete in Folge kamen nicht an.`);
  }
  if (typeof ms !== "number") return nichtLesbar(b);
  const g = GRENZEN["verbindung.antwortzeit"];
  const stufe = stufeNachGrenze(ms, g, vorher);
  const sek = `${zahlDe(ms / 1000, 2)} s`;
  const text = stufe === "gut"
    ? "Antwortzeit der App auf das letzte Messpaket."
    : `Die App antwortet langsam (${sek}), ${stufe === "kritisch" ? "kritisch über 3 s" : "Warnung ab 1 s"}.`;
  return mach(b, stufe, sek, text);
}

// -- Rig --

function cpuTemp(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "cpu.temp", bauteil: "cpu", kachel: "rig", titel: "Prozessor-Temperatur", alarm: true };
  const c = rig.cpu;
  const mittel = c?.temp_c_5min ?? c?.temp_c;
  if (!c || mittel === undefined) return nichtLesbar(b);
  const spitze = c.temp_c_max_1min ?? c.temp_c ?? mittel;
  const wert = grad(c.temp_c ?? mittel);
  const hk = vorher === "kritisch" ? CPU_TEMP.hysterese : 0;
  const hw = vorher === "warnung" || vorher === "kritisch" ? CPU_TEMP.hysterese : 0;
  if (c.drosselung === true) return mach(b, "kritisch", wert, "Der Prozessor bremst sich wegen Hitze selbst.");
  if (spitze >= CPU_TEMP.kritisch - hk) {
    return mach(b, "kritisch", wert, `Spitze ${grad(spitze)} in der letzten Minute, kritisch ab ${CPU_TEMP.kritisch} °C.`);
  }
  if (mittel > CPU_TEMP.mittel_warnung - hw) {
    return mach(b, "warnung", wert, `5-Minuten-Mittel ${grad(mittel)}, Warnung über ${CPU_TEMP.mittel_warnung} °C.`);
  }
  if (spitze >= CPU_TEMP.spitze_warnung - hw) {
    return mach(b, "warnung", wert, `Spitze ${grad(spitze)} in der letzten Minute, Warnung ab ${CPU_TEMP.spitze_warnung} °C.`);
  }
  const hinweis = spitze >= CPU_TEMP.hinweis_ab ? ` Spitze ${grad(spitze)}, Warnung erst ab ${CPU_TEMP.spitze_warnung} °C.` : "";
  return mach(b, "gut", wert, `5-Minuten-Mittel ${grad(mittel)}.${hinweis}`);
}

function cpuLast(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "cpu.last", bauteil: "cpu", kachel: "rig", titel: "Prozessor-Last", alarm: false };
  const c = rig.cpu;
  const last5 = c?.last_prozent_5min ?? c?.last_prozent;
  if (!c || last5 === undefined) return nichtLesbar(b);
  const last10 = c.last_prozent_10min ?? last5;
  const g = GRENZEN["cpu.last"];
  const wert = `${zahlDe(Math.round(c.last_prozent ?? last5))} %`;
  const hk = vorher === "kritisch" ? g.hysterese : 0;
  const hw = vorher === "warnung" || vorher === "kritisch" ? g.hysterese : 0;
  if (last10 > g.kritisch - hk) return mach(b, "kritisch", wert, `10-Minuten-Mittel ${zahlDe(Math.round(last10))} %, Dauervollast bremst die KI.`);
  if (last5 >= g.warnung - hw) return mach(b, "warnung", wert, `5-Minuten-Mittel ${zahlDe(Math.round(last5))} %, Warnung ab ${g.warnung} %.`);
  return mach(b, "gut", wert, `5-Minuten-Mittel ${zahlDe(Math.round(last5))} %.`);
}

function gpuTemp(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "gpu.temp", bauteil: "gpu", kachel: "rig", titel: "Grafikkarte Temperatur", alarm: true };
  const t = rig.minute?.["gpu.temp"] ?? rig.gpu?.temp_c;
  if (t === undefined) return nichtLesbar(b);
  const g = GRENZEN["gpu.temp"];
  const stufe = stufeNachGrenze(t, g, vorher);
  return mach(b, stufe, grad(rig.gpu?.temp_c ?? t), grenzText(stufe, `Minutenmittel ${grad(t)}.`, `Minutenmittel ${grad(t)}`, g));
}

function ramVerfuegbar(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "ram.verfuegbar", bauteil: "ram", kachel: "ram", titel: "Arbeitsspeicher verfügbar", alarm: true };
  const v = rig.ram?.verfuegbar_b;
  if (v === undefined) return nichtLesbar(b);
  const gb = v / GIB;
  const g = GRENZEN["ram.verfuegbar"];
  const stufe = stufeNachGrenze(gb, g, vorher);
  const gesamt = rig.ram?.gesamt_b;
  const gut = gesamt !== undefined ? `Von ${gbBinaer(gesamt)} nutzbar.` : "Genug Reserve für die KI.";
  const text = stufe === "gut"
    ? gut
    : `Nur noch ${gbBinaer(v)} frei, ${stufe === "kritisch" ? `kritisch unter ${g.kritisch}` : `Warnung ab ${g.warnung}`} GB.`;
  return mach(b, stufe, `${gbBinaer(v)} frei`, text);
}

function ramDruck(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "ram.druck", bauteil: "ram", kachel: "ram", titel: "Speicherdruck", alarm: true };
  const p = rig.ram?.psi_full_avg10;
  if (p === undefined) return nichtLesbar(b);
  const g = GRENZEN["ram.druck"];
  const stufe = stufeNachGrenze(p, g, vorher);
  return mach(b, stufe, zahlDe(p, 1), grenzText(stufe, "Kein Engpass beim Arbeitsspeicher.", `Programme warten ${zahlDe(p, 1)} % der Zeit auf Arbeitsspeicher`, g));
}

function ramSeitenfehler(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "ram.seitenfehler", bauteil: "ram", kachel: "ram", titel: "Nachladen von der Platte", alarm: false };
  const n = rig.ram?.seitenfehler_s;
  if (n === undefined) return nichtLesbar(b);
  const g = GRENZEN["ram.seitenfehler"];
  const stufe = stufeNachGrenze(n, g, vorher);
  return mach(b, stufe, `${zahlDe(n)} /s`, grenzText(stufe, "Kaum Nachladen von der Platte.", `${zahlDe(n)} Nachlade-Vorgänge pro Sekunde`, g));
}

function ramKiFest(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "ram.ki_fest", bauteil: "ram", kachel: "ram", titel: "KI-Bereich fest belegt", alarm: true };
  const fest = rig.ram?.ki?.fest_b;
  const grenze = rig.ram?.ki?.grenze_b;
  if (fest === undefined || !grenze) return nichtLesbar(b);
  const pct = prozentVon(fest, grenze);
  const g = GRENZEN["ram.ki_fest"];
  const stufe = stufeNachGrenze(pct, g, vorher);
  const satz = `${gbBinaer(fest)} von ${gbBinaer(grenze, 0)} fest belegt (ohne Zwischenspeicher)`;
  return mach(b, stufe, `${zahlDe(Math.round(pct))} %`, grenzText(stufe, `${satz}.`, satz, g));
}

function ramTrustone(rig: RigPaket): Ampel {
  const b: Basis = { schluessel: "ram.trustone", bauteil: "ram", kachel: null, titel: "Trust one (Summe)", alarm: false };
  const t = rig.ram?.trustone;
  if (t?.summe_b === undefined) return mach(b, "neutral", null, "Trust one · Summe nicht lesbar.", "info");
  const wert = t.grenze_max_b ? `${zahlDe(t.summe_b / GIB, 1)} von ${zahlDe(t.grenze_max_b / GIB, 0)} GB` : gbBinaer(t.summe_b);
  return mach(b, "neutral", wert, `Trust one · ${wert}, vom System hart begrenzt.`, "info");
}

function ramSwap(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "ram.swap", bauteil: "ram", kachel: "ram", titel: "Auslagerung belegt", alarm: false };
  const s = rig.ram?.swap_belegt_b;
  if (s === undefined) return nichtLesbar(b);
  const g = GRENZEN["ram.swap"];
  const stufe = stufeNachGrenze(s / GIB, g, vorher);
  const gesamt = rig.ram?.swap_gesamt_b;
  const satz = `${gbBinaer(s)}${gesamt ? ` von ${gbBinaer(gesamt)}` : ""} ausgelagert`;
  return mach(b, stufe, gbBinaer(s), grenzText(stufe, `${satz}.`, satz, g));
}

function platte(rig: RigPaket, welche: "system" | "tresor", vorher?: Stufe): Ampel {
  const b: Basis = {
    schluessel: `platte.${welche}`,
    bauteil: "platten",
    kachel: "platten",
    titel: welche === "system" ? "Systemplatte" : "Tresor",
    alarm: true,
  };
  const p = rig.platten?.[welche];
  if (!p) return nichtLesbar(b);
  const pct = prozentVon(p.belegt_b, p.gesamt_b);
  const g = GRENZEN.platte;
  const stufe = stufeNachGrenze(pct, g, vorher);
  const satz = `${groesseDezimal(p.belegt_b)} von ${groesseDezimal(p.gesamt_b)} belegt`;
  const zusatz = welche === "tresor" && stufe !== "gut" ? " Ist der Tresor voll, stehen Datenbank und Index." : "";
  return mach(b, stufe, `${zahlDe(Math.round(pct))} %`, `${grenzText(stufe, `${satz}.`, satz, g)}${zusatz}`);
}

const KOMMT_RIG = "kommt mit Freigabe am Rig";
const KOMMT_NAS = "kommt mit NAS-Zugang";

function ssdTemp(rig: RigPaket, vorher?: Stufe): Ampel {
  const b: Basis = { schluessel: "ssd.temp", bauteil: "platten", kachel: "platten", titel: "SSD-Temperatur", alarm: true };
  const ssd = rig.platten?.ssd;
  if (!ssd || ssd.status !== "ok") return mach(b, "neutral", null, KOMMT_RIG, "kommt");
  if (ssd.temp_c === null || ssd.temp_c === undefined) return nichtLesbar(b);
  const g = GRENZEN["ssd.temp"];
  const stufe = stufeNachGrenze(ssd.temp_c, g, vorher);
  return mach(b, stufe, grad(ssd.temp_c), grenzText(stufe, `${grad(ssd.temp_c)}.`, grad(ssd.temp_c), g));
}

function ssdGesundheit(rig: RigPaket): Ampel {
  const b: Basis = { schluessel: "ssd.gesundheit", bauteil: "platten", kachel: "platten", titel: "SSD-Gesundheit", alarm: true };
  const ssd = rig.platten?.ssd;
  if (!ssd || ssd.status !== "ok") return mach(b, "neutral", null, KOMMT_RIG, "kommt");
  const abn = ssd.abnutzung_prozent;
  const details = [
    abn !== null && abn !== undefined ? `Abnutzung ${zahlDe(Math.round(abn))} %` : null,
    ssd.betriebsstunden !== null && ssd.betriebsstunden !== undefined ? `${zahlDe(ssd.betriebsstunden)} Betriebsstunden` : null,
  ].filter(Boolean).join(", ");
  const nachsatz = details ? ` ${details}.` : "";
  if (ssd.gesundheit === "fehler") return mach(b, "kritisch", "Fehler", `Die SSD meldet einen Fehler.${nachsatz}`);
  if (ssd.gesundheit === "warnung") return mach(b, "warnung", "Warnung", `Die SSD meldet eine Warnung.${nachsatz}`);
  if (abn !== null && abn !== undefined && abn >= GRENZEN["ssd.abnutzung"].warnung) {
    return mach(b, "warnung", "Abgenutzt", `Die SSD ist zu ${zahlDe(Math.round(abn))} % abgenutzt, Warnung ab ${GRENZEN["ssd.abnutzung"].warnung} %.`);
  }
  if (ssd.gesundheit === "ok") return mach(b, "gut", "OK", `Selbsttest bestanden.${nachsatz}`);
  return nichtLesbar(b);
}

const ZUSTAND_WORT = { laeuft: "läuft", startet: "startet", neustart: "startet neu", gestoppt: "gestoppt" } as const;

function dienst(d: NonNullable<RigPaket["dienste"]>[number], abstuerze: number): Ampel {
  const name = DIENST_ANZEIGE[d.name];
  const b: Basis = { schluessel: `dienst.${d.name}`, bauteil: "dienste", kachel: "rig", titel: name, alarm: true };
  const wert = ZUSTAND_WORT[d.zustand];
  if (d.oom === true) return mach(b, "kritisch", wert, `${name} wurde wegen Speichermangel beendet.`);
  if (d.zustand === "gestoppt") return mach(b, "kritisch", wert, `${name} läuft nicht.`);
  if (d.gesund === false) return mach(b, "kritisch", "krank", `${name} besteht die eigene Selbstprüfung nicht.`);
  if (d.zustand === "startet" || d.zustand === "neustart") return mach(b, "warnung", wert, `${name} startet gerade.`);
  if (abstuerze > 0) {
    return mach(b, "warnung", wert, `${name} ist in den letzten 24 h ${abstuerze}× unerwartet neu gestartet.`);
  }
  return mach(b, "gut", wert, d.gesund === true ? `${name} läuft und ist gesund.` : `${name} läuft.`);
}

/** Soll-Liste: Fehlt ein Pflichtdienst im Paket (Container entfernt statt
 *  gestoppt), gibt es dafuer eine kritische Ampel statt gar keiner. Der
 *  gruendliche Ollama ist nur Pflicht, solange das Hauptmodell eingeschaltet ist. */
function fehlendeDienste(rig: RigPaket, ki: KiPaket | null): Ampel[] {
  if (!rig.dienste) return [];
  const da = new Set(rig.dienste.map((d) => d.name));
  return DIENST_NAMEN.filter((n) => !da.has(n) && (n !== "ollama_gruendlich" || ki?.schalter?.hauptmodell === true)).map((n) => {
    const name = DIENST_ANZEIGE[n];
    return mach({ schluessel: `dienst.${n}`, bauteil: "dienste", kachel: "rig", titel: name, alarm: true }, "kritisch", "fehlt", `${name} fehlt auf dem Rig.`);
  });
}

// -- KI (aus FSM-Daten) --

function kiWarteschlange(e: AmpelEingabe, jetztMs: number): Ampel {
  const b: Basis = { schluessel: "ki.warteschlange", bauteil: "ki", kachel: "ki", titel: "KI-Warteschlange", alarm: true };
  const n = e.fsm.warteschlange_offen;
  if (!e.fsm.ki_online) {
    return mach(b, "neutral", n > 0 ? `${zahlDe(n)} offen` : null, n > 0 ? "Die KI ist offline, offene Aufträge warten." : "Die KI ist offline.", "info");
  }
  if (n === 0) {
    return e.ki?.auftrag
      ? mach(b, "gut", "Rechnet", "Ein Auftrag läuft, sonst ist nichts offen.")
      : mach(b, "neutral", "Ruht", "Kein Auftrag offen.", "ruht");
  }
  if (!e.fsm.aeltester_offen_am) return mach(b, "gut", `${zahlDe(n)} offen`, `${zahlDe(n)} Aufträge offen.`);
  const alter = jetztMs - Date.parse(e.fsm.aeltester_offen_am);
  const stufe = stufeNachAlter(alter, ZEIT_GRENZEN_MS["ki.warteschlange"]);
  return mach(b, stufe, `${zahlDe(n)} offen`, `Der älteste offene Auftrag wartet seit ${dauer(alter)}.`);
}

// -- NAS --

function nasAmpeln(e: AmpelEingabe, jetztMs: number): Ampel[] {
  const nas = e.nas;
  const v = e.vorher;
  const basis = {
    erreichbar: { schluessel: "nas.erreichbar", bauteil: "nas", kachel: "nas", titel: "NAS erreichbar", alarm: true },
    volume: { schluessel: "nas.volume", bauteil: "nas", kachel: "nas", titel: "NAS-Belegung", alarm: true },
    freigaben: { schluessel: "nas.freigaben", bauteil: "nas", kachel: "nas", titel: "NAS-Freigaben eingehängt", alarm: true },
    systemtemp: { schluessel: "nas.hw.systemtemp", bauteil: "hardware", kachel: null, titel: "NAS-Systemtemperatur", alarm: true },
    plattentemp: { schluessel: "nas.hw.plattentemp", bauteil: "hardware", kachel: null, titel: "NAS-Plattentemperatur", alarm: true },
    plattengesundheit: { schluessel: "nas.hw.plattengesundheit", bauteil: "hardware", kachel: null, titel: "NAS-Plattengesundheit", alarm: true },
    raid: { schluessel: "nas.hw.raid", bauteil: "hardware", kachel: null, titel: "Speicherpool", alarm: true },
    zugang: { schluessel: "nas.hw.zugang", bauteil: "hardware", kachel: null, titel: "NAS-Hardwarewerte", alarm: false },
  } as const satisfies Record<string, Basis>;
  const alle = Object.values(basis) as Basis[];

  if (!nas) return alle.map((b) => mach(b, "neutral", null, "Vom NAS kam noch keine Messung.", "nie_gemeldet"));

  const aus: Ampel[] = [];

  // Erreichbarkeit
  {
    const f = nas.fehlversuche_in_folge;
    const stufe = stufeNachGrenze(f, GRENZEN["nas.erreichbar"]);
    aus.push(stufe === "gut"
      ? mach(basis.erreichbar, stufe, "Erreichbar", "Das NAS antwortet.")
      : mach(basis.erreichbar, stufe, nas.erreichbar ? "Erreichbar" : "Nicht erreichbar", `${zahlDe(f)} Fehlversuche in Folge.`));
  }

  // Belegung
  if (!nas.volume) aus.push(nichtLesbar(basis.volume));
  else {
    const pct = prozentVon(nas.volume.belegt_b, nas.volume.gesamt_b);
    const g = GRENZEN["nas.volume"];
    const stufe = stufeNachGrenze(pct, g, v["nas.volume"]);
    const satz = `${groesseDezimal(nas.volume.belegt_b)} von ${groesseDezimal(nas.volume.gesamt_b)} belegt`;
    aus.push(mach(basis.volume, stufe, `${zahlDe(Math.round(pct))} %`, grenzText(stufe, `${satz}.`, satz, g)));
  }

  // Freigaben (Soll aus der Einhaenge-Konfiguration, nie aus dem Ist)
  const fr = nas.freigaben;
  if (!fr) aus.push(nichtLesbar(basis.freigaben));
  else if (fr.soll === null) {
    aus.push(mach(basis.freigaben, "neutral", `${zahlDe(fr.ist)} eingehängt`, "Das Soll lässt sich auf dem Rig noch nicht bestimmen.", "soll_offen"));
  } else if (fr.ist >= fr.soll) {
    aus.push(mach(basis.freigaben, "gut", `${zahlDe(fr.ist)} von ${zahlDe(fr.soll)}`, "Alle Freigaben sind eingehängt."));
  } else {
    const fehlt = fr.soll - fr.ist;
    const alter = fr.fehlt_seit ? Math.max(0, jetztMs - Date.parse(fr.fehlt_seit)) : 0;
    const stufe = alter > ZEIT_GRENZEN_MS["nas.freigaben"].kritisch ? "kritisch" : "warnung";
    const wer = fehlt === 1 ? "Eine Freigabe fehlt" : `${zahlDe(fehlt)} Freigaben fehlen`;
    aus.push(mach(basis.freigaben, stufe, `${zahlDe(fr.ist)} von ${zahlDe(fr.soll)}`, fr.fehlt_seit ? `${wer} seit ${dauer(alter)}.` : `${wer}.`));
  }

  // Hardware ueber SNMP (ruhend bis Mischa den Zugang einrichtet)
  const s = nas.snmp;
  const hw = [basis.systemtemp, basis.plattentemp, basis.plattengesundheit, basis.raid];
  if (s.status === "nicht_eingerichtet" && s.grund === "zugang_ungueltig") {
    for (const b of hw) aus.push(mach(b, "neutral", null, KOMMT_NAS, "kommt"));
    aus.push(mach(basis.zugang, "warnung", "ungültig", "Die hinterlegten Zugangsdaten auf dem Rig sind unvollständig oder ungültig, die Abfrage ruht."));
  } else if (s.status === "nicht_eingerichtet") {
    for (const b of [...hw, basis.zugang]) aus.push(mach(b, "neutral", null, KOMMT_NAS, "kommt"));
  } else if (s.status === "fehler") {
    const grund: Record<string, string> = {
      zeitlimit: "Das NAS antwortet nicht rechtzeitig auf die Hardware-Abfrage.",
      anmeldung: "Die Anmeldung für die Hardware-Abfrage wurde abgelehnt.",
      keine_antwort: "Das NAS antwortet nicht auf die Hardware-Abfrage.",
      werkzeug_fehlt: "Das Abfrage-Werkzeug fehlt auf dem Rig.",
      unbekannt: "Die Hardware-Abfrage ist fehlgeschlagen.",
    };
    for (const b of hw) aus.push(nichtLesbar(b));
    aus.push(mach(basis.zugang, "warnung", "Fehler", grund[s.grund ?? "unbekannt"]));
  } else {
    if (s.system_temp_c === undefined) aus.push(nichtLesbar(basis.systemtemp));
    else {
      const g = GRENZEN["nas.hw.systemtemp"];
      const stufe = stufeNachGrenze(s.system_temp_c, g, v["nas.hw.systemtemp"]);
      aus.push(mach(basis.systemtemp, stufe, grad(s.system_temp_c), grenzText(stufe, `${grad(s.system_temp_c)}.`, grad(s.system_temp_c), g)));
    }
    // Externe Platten (USB, §1.4) zaehlen mit denselben Grenzen; die Texte nennen sie «USB-Platte», nie «Schacht n».
    const platten = s.platten ?? [];
    let waermste: (typeof platten)[number] | undefined;
    for (const p of platten) if (p.temp_c !== undefined && (waermste?.temp_c === undefined || p.temp_c > waermste.temp_c)) waermste = p;
    if (waermste?.temp_c === undefined) aus.push(nichtLesbar(basis.plattentemp));
    else {
      const max = waermste.temp_c;
      const wo = plattenName(waermste, platten);
      const g = GRENZEN["nas.hw.plattentemp"];
      const stufe = stufeNachGrenze(max, g, v["nas.hw.plattentemp"]);
      aus.push(mach(basis.plattentemp, stufe, grad(max), grenzText(stufe, `Wärmste Platte ${grad(max)} (${wo}).`, `Wärmste Platte ${grad(max)} (${wo})`, g)));
    }
    const gesundheit = platten.map((p) => p.gesundheit).filter((x): x is "ok" | "warnung" | "fehler" => x !== undefined);
    const welche = (x: "warnung" | "fehler") => platten.filter((p) => p.gesundheit === x).map((p) => plattenName(p, platten)).join(", ");
    if (gesundheit.length === 0) aus.push(nichtLesbar(basis.plattengesundheit));
    else if (gesundheit.includes("fehler")) {
      const n = gesundheit.filter((x) => x === "fehler").length;
      aus.push(mach(basis.plattengesundheit, "kritisch", "Fehler", `${n === 1 ? "Eine Platte meldet" : `${n} Platten melden`} einen Fehler (${welche("fehler")}).`));
    } else if (gesundheit.includes("warnung")) {
      const n = gesundheit.filter((x) => x === "warnung").length;
      aus.push(mach(basis.plattengesundheit, "warnung", "Warnung", `${n === 1 ? "Eine Platte meldet" : `${n} Platten melden`} eine Warnung (${welche("warnung")}).`));
    } else {
      aus.push(mach(basis.plattengesundheit, "gut", "OK", `Alle ${zahlDe(gesundheit.length)} Platten sind gesund.`));
    }
    if (!s.raid) aus.push(nichtLesbar(basis.raid));
    else if (s.raid === "degradiert") aus.push(mach(basis.raid, "kritisch", "degradiert", "Der Speicherpool ist beschädigt, eine weitere defekte Platte kann Daten kosten."));
    else if (s.raid === "wiederaufbau") aus.push(mach(basis.raid, "warnung", "Wiederaufbau", "Der Speicherpool baut sich gerade neu auf."));
    else aus.push(mach(basis.raid, "gut", "normal", "Der Speicherpool ist in Ordnung."));
    aus.push(mach(basis.zugang, "gut", "OK", "Die Hardware-Werte des NAS werden gelesen."));
  }

  // Veraltete NAS-Messung: alles neutral, kein Alarm.
  const alter = jetztMs - Date.parse(nas.gemessen_am);
  if (alter > NAS_VERALTET_MS) return aus.map((a) => veralte(a, alter));
  return aus;
}

// -- FSM-eigene Quellen --

function backupFsm(e: AmpelEingabe, jetztMs: number): Ampel {
  const b: Basis = { schluessel: "backup.fsm", bauteil: "backup", kachel: "backup", titel: "FSM-Sicherung aufs NAS", alarm: true };
  const bk = e.fsm.backup;
  if (bk.nie_gemeldet) return mach(b, "neutral", null, "Die FSM-Sicherung hat sich noch nie gemeldet.", "nie_gemeldet");
  if (bk.letzte_status === "fehler") {
    return mach(b, "kritisch", "Fehl-Lauf", `Der letzte Lauf${bk.letzte_meldung_am ? ` (${datumZeit(bk.letzte_meldung_am)})` : ""} ist fehlgeschlagen.`);
  }
  if (!bk.letzte_ok_am) return mach(b, "kritisch", "nie erfolgreich", "Es gab noch keinen erfolgreichen Lauf.");
  const alter = jetztMs - Date.parse(bk.letzte_ok_am);
  const stufe = stufeNachAlter(alter, ZEIT_GRENZEN_MS["backup.fsm"]);
  return stufe === "gut"
    ? mach(b, stufe, vorDauer(alter), `Letzte Sicherung am ${datumZeit(bk.letzte_ok_am)}.`)
    : mach(b, stufe, dauer(alter), `Seit ${dauer(alter)} keine erfolgreiche Sicherung (letzte am ${datumZeit(bk.letzte_ok_am)}).`);
}

function ablageSync(e: AmpelEingabe, jetztMs: number): Ampel {
  const b: Basis = { schluessel: "ablage.sync", bauteil: "ablage", kachel: null, titel: "Ablage-Abgleich", alarm: true };
  const poll = e.fsm.sync.letzter_poll;
  if (!poll) return mach(b, "neutral", null, "Der Ablage-Abgleich hat sich noch nie gemeldet.", "nie_gemeldet");
  const alter = jetztMs - Date.parse(poll);
  const stufe = stufeNachAlter(alter, ZEIT_GRENZEN_MS["ablage.sync"]);
  return mach(b, stufe, vorDauer(alter), stufe === "gut" ? `Letzter Abgleich um ${uhrzeit(poll)}.` : `Seit ${dauer(alter)} kein Abgleich mit dem NAS.`);
}

function ablageIndex(e: AmpelEingabe, jetztMs: number): Ampel {
  const b: Basis = { schluessel: "ablage.index", bauteil: "index", kachel: null, titel: "Datei-Index", alarm: true };
  const scan = e.fsm.index.letzter_scan;
  if (!scan) return mach(b, "neutral", null, "Der Datei-Index hat noch nie gescannt.", "nie_gemeldet");
  const alter = jetztMs - Date.parse(scan);
  const stufe = stufeNachAlter(alter, ZEIT_GRENZEN_MS["ablage.index"]);
  return mach(b, stufe, vorDauer(alter), stufe === "gut" ? `Letzter Scan um ${uhrzeit(scan)}.` : `Seit ${dauer(alter)} kein neuer Scan der Ablage.`);
}

// -- Veraltet --

function veralte(a: Ampel, alterMs: number): Ampel {
  return { ...a, stufe: "neutral", neutral: "veraltet", text: `Stand ${vorDauer(alterMs)}.`, alarm: false };
}

// ---- Einstieg -----------------------------------------------------------------

/** Bewertet alle Ampeln (Reihenfolge wie Vertrag §4). `seit` bleibt null — das
 *  fuellt die Lese-API aus technik_zustaende. */
export function bewerteAmpeln(e: AmpelEingabe): Ampel[] {
  const jetztMs = e.jetzt.getTime();
  const v = e.vorher;
  const aus: Ampel[] = [];

  const online = verbindungOnline(e, jetztMs);
  aus.push(online);
  const frische = messwerteFrische(e, jetztMs, online.stufe === "gut");
  aus.push(frische);

  const antwort = verbindungAntwortzeit(e.ki, v["verbindung.antwortzeit"]);
  const kiAlter = e.ki_gemessen_am ? jetztMs - Date.parse(e.ki_gemessen_am) : 0;
  aus.push(e.ki && kiAlter >= ZEIT_GRENZEN_MS["messwerte.frische"].warnung ? veralte(antwort, kiAlter) : antwort);

  // Aus dem Rig abgeleitet
  const rigNamen = [
    ["cpu.temp", "cpu", "rig", "Prozessor-Temperatur"],
    ["cpu.last", "cpu", "rig", "Prozessor-Last"],
    ["gpu.temp", "gpu", "rig", "Grafikkarte Temperatur"],
    ["ram.verfuegbar", "ram", "ram", "Arbeitsspeicher verfügbar"],
    ["ram.druck", "ram", "ram", "Speicherdruck"],
    ["ram.seitenfehler", "ram", "ram", "Nachladen von der Platte"],
    ["ram.ki_fest", "ram", "ram", "KI-Bereich fest belegt"],
    ["ram.trustone", "ram", null, "Trust one (Summe)"],
    ["ram.swap", "ram", "ram", "Auslagerung belegt"],
    ["platte.system", "platten", "platten", "Systemplatte"],
    ["platte.tresor", "platten", "platten", "Tresor"],
    ["ssd.temp", "platten", "platten", "SSD-Temperatur"],
    ["ssd.gesundheit", "platten", "platten", "SSD-Gesundheit"],
  ] as const;
  const rig = e.rig;
  if (!rig) {
    for (const [schluessel, bauteil, kachel, titel] of rigNamen) {
      aus.push(mach({ schluessel, bauteil, kachel, titel, alarm: false }, "neutral", null, "Noch keine Messwerte vom Rig.", "nie_gemeldet"));
    }
  } else {
    const rigAmpeln: Ampel[] = [
      cpuTemp(rig, v["cpu.temp"]),
      cpuLast(rig, v["cpu.last"]),
      gpuTemp(rig, v["gpu.temp"]),
      ramVerfuegbar(rig, v["ram.verfuegbar"]),
      ramDruck(rig, v["ram.druck"]),
      ramSeitenfehler(rig, v["ram.seitenfehler"]),
      ramKiFest(rig, v["ram.ki_fest"]),
      ramTrustone(rig),
      ramSwap(rig, v["ram.swap"]),
      platte(rig, "system", v["platte.system"]),
      platte(rig, "tresor", v["platte.tresor"]),
      ssdTemp(rig, v["ssd.temp"]),
      ssdGesundheit(rig),
      ...(rig.dienste ?? []).map((d) => dienst(d, e.abstuerze24h[d.name] ?? 0)),
      ...fehlendeDienste(rig, e.ki),
    ];
    const alter = jetztMs - Date.parse(rig.gemessen_am);
    const frisch = frische.stufe === "gut";
    aus.push(...(frisch ? rigAmpeln : rigAmpeln.map((a) => veralte(a, alter))));
  }

  aus.push(kiWarteschlange(e, jetztMs));
  aus.push(...nasAmpeln(e, jetztMs));
  aus.push(backupFsm(e, jetztMs));
  // Ablage-Abgleich und Datei-Index laufen auf dem Rig. Ist das Rig weg (kein
  // Kontakt oder keine Messwerte mehr), sind sie nur Folgen davon: Die Ampel
  // zeigt den Zustand weiter, alarmiert aber nicht (eine Meldung statt drei).
  const rigWeg = online.stufe === "kritisch" || (e.rig !== null && frische.stufe === "kritisch");
  const folge = (a: Ampel): Ampel => (rigWeg ? { ...a, alarm: false } : a);
  aus.push(folge(ablageSync(e, jetztMs)));
  aus.push(folge(ablageIndex(e, jetztMs)));
  return aus;
}

/** Gesamtstatus: schlechteste nicht-neutrale Stufe; Probleme kritisch zuerst. */
export function gesamtAus(ampeln: Ampel[]): { stufe: Stufe; probleme: Ampel[] } {
  const probleme = ampeln
    .filter((a) => a.stufe === "kritisch" || a.stufe === "warnung")
    .sort((a, b) => RANG[b.stufe] - RANG[a.stufe]);
  if (probleme.length > 0) return { stufe: probleme[0].stufe, probleme };
  return { stufe: ampeln.some((a) => a.stufe === "gut") ? "gut" : "neutral", probleme };
}

/** Stufe einer Kachel der Statusleiste = schlechteste Ampel mit dieser Kachel. */
export function kachelStufe(ampeln: Ampel[], kachel: Kachel): Stufe {
  let beste: Stufe = "neutral";
  for (const a of ampeln) if (a.kachel === kachel && RANG[a.stufe] > RANG[beste]) beste = a.stufe;
  return beste;
}
