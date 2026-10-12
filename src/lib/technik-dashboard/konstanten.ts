// Feste Werte des Technik-Dashboards (docs/technik-dashboard/VERTRAG.md).
// Eine Quelle fuer Ampel-Grenzen, Hysterese, Fenster und Paket-Grenzen:
// die Ampel-Logik (ampeln.ts), die Lese-API und die Seite (Grenzlinien der
// Kurven) lesen alle von hier. Wer eine Grenze aendert, aendert sie zuerst im
// Vertrag §4.

import type { Bereich, DienstName } from "./typen";

// ---- Paket (§2.1) -----------------------------------------------------------

export const TECHNIK_PAKET_VERSION = 1;
/** Hoechstgroesse eines Pakets in Bytes (sonst 413). */
export const TECHNIK_PAKET_MAX_BYTES = 64 * 1024;
/** Zeitstempel duerfen hoechstens so weit in der Zukunft liegen (Uhrabweichung). */
export const TECHNIK_ZUKUNFT_TOLERANZ_MS = 5 * 60_000;
/** Ausnahme: geplante Entlade-Zeit eines geladenen Modells liegt naturgemaess in der Zukunft. */
export const TECHNIK_ENTLADEN_MAX_ZUKUNFT_MS = 7 * 24 * 3600_000;
/** Aeltere Mess-Bloecke (rig/nas) werden verworfen — sie gehoeren in keine Minute mehr. */
export const TECHNIK_BLOCK_MAX_ALTER_MS = 24 * 3600_000;

export const TECHNIK_ARRAY_MAX = {
  dienste: 12,
  modelle: 50,
  geladen: 10,
  platten: 8,
  module: 8,
  luefter_rpm: 8,
  instanzen: 2,
} as const;

/** Dienst-Namen im Paket (§1.1) und ihre Anzeige. */
export const DIENST_NAMEN = [
  "ki_dienst",
  "ollama_schnell",
  "ollama_gruendlich",
  "whisper",
  "datenbank",
  "webserver",
  "ausgang",
] as const satisfies readonly DienstName[];

export const DIENST_ANZEIGE: Readonly<Record<DienstName, string>> = {
  ki_dienst: "KI-Dienst",
  ollama_schnell: "Ollama schnell",
  ollama_gruendlich: "Ollama gründlich",
  whisper: "Whisper (Sprache)",
  datenbank: "Datenbank",
  webserver: "Webserver",
  ausgang: "Ausgang",
};

// ---- Minutenwerte (§2.3) ----------------------------------------------------

/** Vom Sammler gebildet (Block `rig.minute`); andere Schluessel werden verworfen. */
export const MINUTEN_SCHLUESSEL_RIG = [
  "cpu.temp", "cpu.temp.max", "cpu.last", "cpu.last.max", "cpu.takt_mhz",
  "gpu.temp", "gpu.temp.max", "gpu.last", "gpu.last.max", "gpu.vram_mib", "gpu.watt",
  "ram.verfuegbar_gb", "ram.ki_gb", "ram.ki_fest_gb", "ram.trustone_gb", "ram.swap_gb",
  "ram.psi_full", "ram.psi_full.max", "ram.seitenfehler_s", "ram.seitenfehler_s.max",
  "netz.rx_bps", "netz.tx_bps", "platte.lesen_bps", "platte.schreiben_bps", "ssd.temp",
] as const;

/** Vom FSM aus dem Block `ki` abgeleitet. */
export const MINUTEN_SCHLUESSEL_KI = ["ki.warteschlange", "ki.geladen_gb", "ki.tokens_s", "ki.fsm_antwort_ms"] as const;

/** Vom FSM aus dem Block `nas` abgeleitet (nur bei neuer NAS-Messung). */
export const MINUTEN_SCHLUESSEL_NAS = ["nas.belegt_prozent", "nas.system_temp", "nas.platte_temp.max", "nas.last"] as const;

export const MINUTEN_SCHLUESSEL: readonly string[] = [
  ...MINUTEN_SCHLUESSEL_RIG,
  ...MINUTEN_SCHLUESSEL_KI,
  ...MINUTEN_SCHLUESSEL_NAS,
];

/** Kurven-Schluessel, deren Wert nur als `<basis>.max` existiert (`nas.platte_temp`):
 *  ihre Kurve hat kein Mittel, nur die Spitze. */
export const REIHEN_NUR_SPITZE: readonly string[] = MINUTEN_SCHLUESSEL
  .filter((s) => s.endsWith(".max"))
  .map((s) => s.slice(0, -4))
  .filter((basis) => !MINUTEN_SCHLUESSEL.includes(basis));

/** Schluessel der Kurven (ohne `.max` — die Spitze steckt im Tupel). */
export const REIHEN_SCHLUESSEL: readonly string[] = [
  ...MINUTEN_SCHLUESSEL.filter((s) => !s.endsWith(".max")),
  ...REIHEN_NUR_SPITZE,
];

export type TechnikQuelle = "rig" | "ki" | "nas";

/** Quelle eines Minuten-/Reihen-Schluessels. */
export function quelleVonSchluessel(schluessel: string): TechnikQuelle {
  if (schluessel.startsWith("ki.")) return "ki";
  if (schluessel.startsWith("nas.")) return "nas";
  return "rig";
}

// ---- Zeitraeume (§6.2) ------------------------------------------------------

export const BEREICHE: readonly Bereich[] = ["6h", "24h", "7d"];
export const BEREICH_SCHRITT_S: Readonly<Record<Bereich, number>> = { "6h": 60, "24h": 300, "7d": 3600 };
export const BEREICH_DAUER_MS: Readonly<Record<Bereich, number>> = {
  "6h": 6 * 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
};
export const EREIGNISSE_MAX = 200;

// ---- Ampel-Grenzen (§4) -----------------------------------------------------
//
// Lesart je Grenze: `richtung: "hoch"` = hoeher ist schlechter. Warnung ab
// `warnung` (einschliesslich), kritisch ueber `kritisch` (ausschliesslich).
// `richtung: "tief"` = tiefer ist schlechter: Warnung bis `warnung`
// (einschliesslich), kritisch unter `kritisch`.
// Hysterese: eine einmal erreichte Stufe faellt erst zurueck, wenn der Wert
// die Grenze um `hysterese` unterschreitet (bzw. bei "tief" ueberschreitet).

export interface Grenze {
  warnung: number;
  kritisch: number;
  richtung: "hoch" | "tief";
  hysterese: number;
  einheit: string;
}

export const HYSTERESE_TEMPERATUR_C = 3;
export const HYSTERESE_PROZENT = 5;
export const HYSTERESE_GB = 0.5;

/** Prozessor-Temperatur: 5-Minuten-Mittel > 85 °C oder Minuten-Spitze ≥ 95 °C = Warnung,
 *  Spitze ≥ 98 °C oder Hitze-Drosselung = kritisch. Spitze zwischen 80 und 95 °C bei
 *  sonst gutem Stand = nur Text-Hinweis. */
export const CPU_TEMP = {
  mittel_warnung: 85,
  spitze_warnung: 95,
  kritisch: 98,
  hinweis_ab: 80,
  hysterese: HYSTERESE_TEMPERATUR_C,
} as const;

export const GRENZEN = {
  "cpu.last":            { warnung: 80, kritisch: 95, richtung: "hoch", hysterese: HYSTERESE_PROZENT, einheit: "%" },
  "gpu.temp":            { warnung: 75, kritisch: 85, richtung: "hoch", hysterese: HYSTERESE_TEMPERATUR_C, einheit: "°C" },
  "ram.verfuegbar":      { warnung: 8, kritisch: 4, richtung: "tief", hysterese: HYSTERESE_GB, einheit: "GB" },
  // Speicherdruck ist ein Prozentwert, aber mit Warnschwelle 5: 5 Punkte Hysterese
  // liessen die Warnung nie mehr fallen (erst unter 0). Darum 2 Punkte.
  "ram.druck":           { warnung: 5, kritisch: 30, richtung: "hoch", hysterese: 2, einheit: "" },
  "ram.seitenfehler":    { warnung: 500, kritisch: 3000, richtung: "hoch", hysterese: 0, einheit: "/s" },
  "ram.ki_fest":         { warnung: 80, kritisch: 95, richtung: "hoch", hysterese: HYSTERESE_PROZENT, einheit: "%" },
  "ram.swap":            { warnung: 2, kritisch: 6, richtung: "hoch", hysterese: HYSTERESE_GB, einheit: "GB" },
  "platte":              { warnung: 80, kritisch: 90, richtung: "hoch", hysterese: HYSTERESE_PROZENT, einheit: "%" },
  "ssd.temp":            { warnung: 60, kritisch: 70, richtung: "hoch", hysterese: HYSTERESE_TEMPERATUR_C, einheit: "°C" },
  "ssd.abnutzung":       { warnung: 90, kritisch: Number.POSITIVE_INFINITY, richtung: "hoch", hysterese: 0, einheit: "%" },
  "nas.erreichbar":      { warnung: 1, kritisch: 2, richtung: "hoch", hysterese: 0, einheit: "" }, // kritisch ab 3 Fehlversuchen
  "nas.volume":          { warnung: 80, kritisch: 90, richtung: "hoch", hysterese: HYSTERESE_PROZENT, einheit: "%" },
  "nas.hw.systemtemp":   { warnung: 70, kritisch: 85, richtung: "hoch", hysterese: HYSTERESE_TEMPERATUR_C, einheit: "°C" },
  "nas.hw.plattentemp":  { warnung: 45, kritisch: 55, richtung: "hoch", hysterese: HYSTERESE_TEMPERATUR_C, einheit: "°C" },
  "verbindung.antwortzeit": { warnung: 1000, kritisch: 3000, richtung: "hoch", hysterese: 0, einheit: "ms" },
} as const satisfies Record<string, Grenze>;

/** Zeit-Grenzen in Millisekunden (ohne Hysterese). Warnung ab, kritisch ueber. */
export const ZEIT_GRENZEN_MS = {
  "verbindung.online": { warnung: 90_000, kritisch: 10 * 60_000 }, // 90 s = KI_ONLINE_FENSTER_MS
  "messwerte.frische": { warnung: 3 * 60_000, kritisch: 10 * 60_000 },
  "ki.warteschlange":  { warnung: 10 * 60_000, kritisch: 30 * 60_000 },
  "nas.freigaben":     { warnung: 0, kritisch: 10 * 60_000 },
  "backup.fsm":        { warnung: 26 * 3600_000, kritisch: 48 * 3600_000 },
  "ablage.sync":       { warnung: 5 * 60_000, kritisch: 15 * 60_000 },
  "ablage.index":      { warnung: 30 * 60_000, kritisch: 60 * 60_000 },
} as const;

/** Ab diesem Alter gelten die NAS-Ampeln als veraltet. */
export const NAS_VERALTET_MS = 5 * 60_000;
/** Wann der Fehlerzaehler der FSM-Verbindung kritisch wird. */
export const FSM_FEHLER_KRITISCH = 3;
/** Ein gemeldetes Tempo gilt nur als Minutenwert, solange es so frisch ist. */
export const TEMPO_FRISCH_MS = 2 * 60_000;

/** Grenzlinien fuer die Kurven der Seite (Reihen-Schluessel → Grenzen). */
export const KURVEN_GRENZEN: Readonly<Record<string, { warnung: number; kritisch: number; richtung: "hoch" | "tief" }>> = {
  "cpu.temp": { warnung: CPU_TEMP.mittel_warnung, kritisch: CPU_TEMP.kritisch, richtung: "hoch" },
  "cpu.last": { warnung: GRENZEN["cpu.last"].warnung, kritisch: GRENZEN["cpu.last"].kritisch, richtung: "hoch" },
  "gpu.temp": { warnung: GRENZEN["gpu.temp"].warnung, kritisch: GRENZEN["gpu.temp"].kritisch, richtung: "hoch" },
  "ram.verfuegbar_gb": { warnung: GRENZEN["ram.verfuegbar"].warnung, kritisch: GRENZEN["ram.verfuegbar"].kritisch, richtung: "tief" },
  "ram.swap_gb": { warnung: GRENZEN["ram.swap"].warnung, kritisch: GRENZEN["ram.swap"].kritisch, richtung: "hoch" },
  "ram.psi_full": { warnung: GRENZEN["ram.druck"].warnung, kritisch: GRENZEN["ram.druck"].kritisch, richtung: "hoch" },
  "ram.seitenfehler_s": { warnung: GRENZEN["ram.seitenfehler"].warnung, kritisch: GRENZEN["ram.seitenfehler"].kritisch, richtung: "hoch" },
  "ssd.temp": { warnung: GRENZEN["ssd.temp"].warnung, kritisch: GRENZEN["ssd.temp"].kritisch, richtung: "hoch" },
  "nas.belegt_prozent": { warnung: GRENZEN["nas.volume"].warnung, kritisch: GRENZEN["nas.volume"].kritisch, richtung: "hoch" },
  "nas.system_temp": { warnung: GRENZEN["nas.hw.systemtemp"].warnung, kritisch: GRENZEN["nas.hw.systemtemp"].kritisch, richtung: "hoch" },
  "nas.platte_temp": { warnung: GRENZEN["nas.hw.plattentemp"].warnung, kritisch: GRENZEN["nas.hw.plattentemp"].kritisch, richtung: "hoch" },
  "ki.fsm_antwort_ms": { warnung: GRENZEN["verbindung.antwortzeit"].warnung, kritisch: GRENZEN["verbindung.antwortzeit"].kritisch, richtung: "hoch" },
};

// ---- Alarme (§5) ------------------------------------------------------------

/** So lange muss eine Ampel ununterbrochen kritisch sein, bevor alarmiert wird. */
export const ALARM_NACH_MS = 10 * 60_000;
/** Mindestabstand zwischen zwei Alarmen zum selben Problem, wenn es zwischendurch
 *  entwarnt war (neuer Vorfall). */
export const ALARM_DROSSEL_MS = 6 * 3600_000;
/** Erinnerung an ein andauerndes, noch nicht entwarntes Problem: hoechstens 1× pro 24 h. */
export const ALARM_ERINNERUNG_MS = 24 * 3600_000;
/** Diese Ampeln alarmieren nur in der App, nie per Mail (die Mail verschickt schon nas-backup-check). */
export const ALARM_OHNE_MAIL: readonly string[] = ["backup.fsm"];

// ---- Aufbewahrung (§3, umgesetzt in technik_verdichten()) -------------------

export const AUFBEWAHRUNG = { minuten_h: 48, stunden_tage: 90, ereignisse_tage: 90 } as const;
