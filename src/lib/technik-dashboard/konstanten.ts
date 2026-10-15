// Feste Werte des Technik-Dashboards (docs/technik-dashboard/VERTRAG.md).
// Eine Quelle fuer Ampel-Grenzen, Hysterese, Fenster und Paket-Grenzen:
// die Ampel-Logik (ampeln.ts), die Lese-API und die Seite (Grenzlinien der
// Kurven) lesen alle von hier. Wer eine Grenze aendert, aendert sie zuerst im
// Vertrag §4.

import type {
  Bereich, DienstName, Instanz, KiHintergrund, KiModellRolle, LeistungZeitraum, LuefterOrt, LuefterProfil,
} from "./typen";

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
  kuehlung_luefter: 12,
  leistung_auftraege: 12,
  ki_modelle: 6,
} as const;

// ---- Kuehlung und Luefter-Profil (§2.5) ---------------------------------------

export const LUEFTER_PROFILE = ["leise", "ausgewogen", "kuehl"] as const satisfies readonly LuefterProfil[];
/** Gilt, solange niemand ein Profil gewaehlt hat (Seed der Migration 318). */
export const LUEFTER_PROFIL_STANDARD: LuefterProfil = "ausgewogen";
export const LUEFTER_ORTE = ["radiator", "front", "heck", "boden", "unbekannt"] as const satisfies readonly LuefterOrt[];
/** Das Rig uebernimmt ein neues Profil binnen 2 min; die Seite wartet etwas laenger (Abruf alle 15 s),
 *  danach zeigt sie ruhig «Rig hat noch nicht übernommen». */
export const PROFIL_UEBERNAHME_MS = 150_000;
/** Hoechste plausible Drehzahl fuer Luefter und Pumpe (darueber verworfen). */
export const KUEHLUNG_RPM_MAX = 30_000;

export const PROFIL_ANZEIGE: Readonly<Record<LuefterProfil, string>> = { leise: "Leise", ausgewogen: "Ausgewogen", kuehl: "Kühl" };
/** Ort eines Luefters in der Anzeige; «unbekannt» ohne Zusatz. */
export const LUEFTER_ORT_ANZEIGE: Readonly<Record<LuefterOrt, string>> = { radiator: "Radiator", front: "Front", heck: "Heck", boden: "Boden", unbekannt: "" };

/** «Lüfter 2 (Front)» — Seite und Ampel-Texte nennen Luefter nur so. */
export function luefterName(l: { nr: number; ort: LuefterOrt }): string {
  const ort = LUEFTER_ORT_ANZEIGE[l.ort];
  return ort ? `Lüfter ${l.nr} (${ort})` : `Lüfter ${l.nr}`;
}

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

// ---- Geladene KI-Modelle (§2.7) ----------------------------------------------

export const KI_MODELL_ROLLEN = ["sprache", "einbettung"] as const satisfies readonly KiModellRolle[];
export const KI_HINTERGRUENDE = [
  "rueckstau_zz", "fristen", "selbsttest", "tiefen_index", "vorbilder_index", "doppel_pruefung", "hauptmodell",
] as const satisfies readonly KiHintergrund[];
export const KI_HINTERGRUND_ANZEIGE: Readonly<Record<KiHintergrund, string>> = {
  rueckstau_zz: "Rückstau ZZ", fristen: "Fristen", selbsttest: "Selbsttest", tiefen_index: "Tiefen-Index",
  vorbilder_index: "Archiv-Index", doppel_pruefung: "Doppel-Prüfung", hauptmodell: "Hauptmodell",
};

/** «Grosses Modell (26B)»: Rolle nach Instanz (Suchmodell = Einbettung), Groesse aus dem Modellnamen.
 *  Seite und Texte nennen geladene Modelle nur so; der volle Name steht daneben. */
export function modellAnzeige(m: { instanz: Instanz; name?: string; rolle?: KiModellRolle }): string {
  const rolle = m.rolle === "einbettung" ? "Suchmodell" : m.instanz === "gruendlich" ? "Grosses Modell" : "Schnelles Modell";
  const p = m.name?.match(/(?:^|[:/_-])(\d{1,4}(?:\.\d{1,2})?)b(?=$|[-_.:])/i);
  return p ? `${rolle} (${p[1].replace(".", ",")}B)` : rolle;
}

/** Wo ein Modell liegt, aus Groesse und Anteil im Grafikspeicher (Ollama size/size_vram): «Grafikkarte»,
 *  «Prozessor» oder geteilt «60 % Grafikkarte / 40 % Prozessor». Ohne beide Werte: null. */
export function modellOrt(m: { groesse_b?: number; vram_b?: number }): string | null {
  if (m.groesse_b == null || m.vram_b == null || m.groesse_b <= 0) return null;
  const gpu = Math.round((Math.min(m.vram_b, m.groesse_b) / m.groesse_b) * 100);
  if (gpu >= 100) return "Grafikkarte";
  if (gpu <= 0) return "Prozessor";
  return `${gpu} % Grafikkarte / ${100 - gpu} % Prozessor`;
}

/** «rechnet» / «ruht» aus der Last, «lädt» solange Ollama das Modell noch nicht meldet, sonst «geladen». */
export function modellZustand(m: { zustand: "geladen" | "laedt"; rechnet?: boolean }): "rechnet" | "ruht" | "lädt" | "geladen" {
  if (m.zustand === "laedt") return "lädt";
  return m.rechnet === true ? "rechnet" : m.rechnet === false ? "ruht" : "geladen";
}

/** Anzeige einer NAS-Platte (§1.4): «Schacht 01» … im Gehaeuse, extern «USB-Platte» bzw. bei mehreren
 *  «USB-Platte 1», «USB-Platte 2» (nach Geraetenummer). Seite und Ampel-Texte nennen Platten nur so. */
export function plattenName(p: { schacht: number; extern?: boolean }, alle: readonly { schacht: number; extern?: boolean }[]): string {
  if (!p.extern) return `Schacht ${String(p.schacht).padStart(2, "0")}`;
  const externe = alle.filter((x) => x.extern).map((x) => x.schacht).sort((a, b) => a - b);
  return externe.length > 1 ? `USB-Platte ${externe.indexOf(p.schacht) + 1}` : "USB-Platte";
}

// ---- Minutenwerte (§2.3) ----------------------------------------------------

/** Vom Sammler gebildet (Block `rig.minute`); andere Schluessel werden verworfen. */
export const MINUTEN_SCHLUESSEL_RIG = [
  "cpu.temp", "cpu.temp.max", "cpu.last", "cpu.last.max", "cpu.takt_mhz",
  "gpu.temp", "gpu.temp.max", "gpu.last", "gpu.last.max", "gpu.vram_mib", "gpu.watt",
  "ram.verfuegbar_gb", "ram.ki_gb", "ram.ki_fest_gb", "ram.trustone_gb", "ram.swap_gb",
  "ram.psi_full", "ram.psi_full.max",
  // Aktives Ein- und Auslagern (Bytes/s, /proc/vmstat pswpin/pswpout), Nachtrag 15.10.2026
  "ram.swap_ein_bps", "ram.swap_aus_bps",
  "netz.rx_bps", "netz.tx_bps", "platte.lesen_bps", "platte.schreiben_bps", "ssd.temp",
  // Kuehlung (§2.5): Kuehlmittel-Temperatur, Pumpe und Mittel aller Luefter
  "kuehlung.kuehlmittel_c", "kuehlung.pumpe_rpm", "kuehlung.luefter_rpm",
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

// Arbeitsspeicher (Neuregel 15.10.2026, Mischa: «wieso steht beim RAM die ganze Zeit Warnung?»). Belegte
// Auslagerung allein ist kein Engpass: Linux laesst alte, ruhende Seiten dort liegen (seit 14.10. 01 Uhr
// 2,2–2,7 GB, bei 28–34 GB verfuegbar und Speicherdruck 0). Bewertet werden darum nur noch verfuegbarer RAM,
// Speicherdruck und aktives Ein-/Auslagern; die Belegung ist eine Info-Zeile. Kalibriert am Speicherprofil
// 11.10. 20:30 – 15.10. 17:00 (5552 Minuten) und den Minutenreihen 12.–15.10.:
//   Normalbetrieb: verfuegbar mind. 20,1 GB · Speicherdruck hoechstens 2,3 (Minuten-Spitze) · netto
//   ausgelagert hoechstens 5,5 MB/s im 5-Minuten-Mittel (14.10. 00:53, kein Fenster ab 8 MB/s).
//   Messnacht 11./12.10. (26B, KI-Bereich am Anschlag, 4 Speicher-Abbrueche): verfuegbar mind. 11,9 GB ·
//   Speicherdruck bis 5,6 (5,9 im 5-s-Monitor) · netto ausgelagert bis 21,9 MB/s (9 Fenster ab 10 MB/s).
// Seitenfehler (pgmajfault) taugen nicht: beim Lesen von Dateien stiegen sie im Normalbetrieb hoeher
// (Minuten-Spitze 1786/s) als in der Messnacht (728/s im 5-Minuten-Mittel) — ersetzt durch pswpin/pswpout.
export const GRENZEN = {
  "cpu.last":            { warnung: 80, kritisch: 95, richtung: "hoch", hysterese: HYSTERESE_PROZENT, einheit: "%" },
  "gpu.temp":            { warnung: 75, kritisch: 85, richtung: "hoch", hysterese: HYSTERESE_TEMPERATUR_C, einheit: "°C" },
  "ram.verfuegbar":      { warnung: 8, kritisch: 4, richtung: "tief", hysterese: HYSTERESE_GB, einheit: "GB" },
  // Speicherdruck (PSI memory, % der Zeit, Mittel 10 s): Warnung, sobald einzelne Programme ab 5 % der Zeit
  // warten («some»), kritisch erst, wenn alle Programme ueber 30 % stillstehen («full», = Abbruchgrenze des
  // KI-Waechters). Mit Warnschwelle 5 liessen 5 Punkte Hysterese die Warnung nie mehr fallen: darum 2 Punkte.
  "ram.druck":           { warnung: 5, kritisch: 30, richtung: "hoch", hysterese: 2, einheit: "%" },
  // Aktives Ein- oder Auslagern: groessere Richtung im 5-Minuten-Mittel, MB/s (binaer wie RAM). Nur Warnung —
  // ein echter Engpass zeigt sich zusaetzlich im Speicherdruck bzw. im verfuegbaren RAM, die alarmieren.
  "ram.auslagern":       { warnung: 10, kritisch: Number.POSITIVE_INFINITY, richtung: "hoch", hysterese: 2, einheit: "MB/s" },
  "ram.ki_fest":         { warnung: 80, kritisch: 95, richtung: "hoch", hysterese: HYSTERESE_PROZENT, einheit: "%" },
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
  "ram.psi_full": { warnung: GRENZEN["ram.druck"].warnung, kritisch: GRENZEN["ram.druck"].kritisch, richtung: "hoch" },
  "ssd.temp": { warnung: GRENZEN["ssd.temp"].warnung, kritisch: GRENZEN["ssd.temp"].kritisch, richtung: "hoch" },
  "nas.belegt_prozent": { warnung: GRENZEN["nas.volume"].warnung, kritisch: GRENZEN["nas.volume"].kritisch, richtung: "hoch" },
  "nas.system_temp": { warnung: GRENZEN["nas.hw.systemtemp"].warnung, kritisch: GRENZEN["nas.hw.systemtemp"].kritisch, richtung: "hoch" },
  "nas.platte_temp": { warnung: GRENZEN["nas.hw.plattentemp"].warnung, kritisch: GRENZEN["nas.hw.plattentemp"].kritisch, richtung: "hoch" },
  "ki.fsm_antwort_ms": { warnung: GRENZEN["verbindung.antwortzeit"].warnung, kritisch: GRENZEN["verbindung.antwortzeit"].kritisch, richtung: "hoch" },
};

// ---- Leistung der lokalen KI (§2.6, §6.5) -------------------------------------

/** Zeitraeume des Abschnitts «Leistung»; der Sammler rechnet je Zeitraum, das FSM liest nur. */
export const LEISTUNG_ZEITRAEUME = ["7d", "30d", "alle"] as const satisfies readonly LeistungZeitraum[];
export const LEISTUNG_ZEITRAUM_STANDARD: LeistungZeitraum = "30d";
export const LEISTUNG_ZEITRAUM_MS: Readonly<Record<LeistungZeitraum, number | null>> = {
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
  alle: null,
};
/** Protokoll-Arten des Rigs, die als Kennzahl zaehlen: ausser den Auftraegen der App (KI_ARTEN) die Nachtarbeit und
 *  (seit 15.10.2026) die Sicherheits-Rapporte — Arten, die das Rig selbst anstoesst. */
export const LEISTUNG_RIG_ARTEN = ["nacht_fristen", "nacht_zz", "sicherheit_rapport"] as const;
/** Arten mit einem gelesenen Dokument: nur dort Seiten, Zeichen, gescannt und Teile (ki_protokoll seit 15.10.2026). */
export const LEISTUNG_DOKUMENT_ARTEN = ["ablage_analyse", "beleg_analyse", "warenkorb_analyse", "nacht_zz"] as const;
/** Hoechstens so viele Selbsttest-Laeufe (neueste zuerst) kommen vom Rig. */
export const LEISTUNG_SELBSTTEST_MAX = 30;
/** Die Leistung kommt alle 10 min; aelter als 2 h gilt sie als veraltet (Stand wird angezeigt). */
export const LEISTUNG_VERALTET_MS = 2 * 3600_000;

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
