// Technik-Dashboard: Paket vom Rig (v1) und Antwort von GET /api/technik/stand.
// Verbindlich laut docs/technik-dashboard/VERTRAG.md — Aenderungen nur ueber den Vertrag.

export type DienstName = "ki_dienst" | "ollama_schnell" | "ollama_gruendlich" | "whisper" | "datenbank" | "webserver" | "ausgang";
export type Instanz = "schnell" | "gruendlich";

/** Luefter-Profil des Rigs (§2.5): die App setzt den Wunsch, das Rig meldet das aktive. */
export type LuefterProfil = "leise" | "ausgewogen" | "kuehl";
export type LuefterOrt = "radiator" | "front" | "heck" | "boden" | "unbekannt";

/** Kuehlung des Rigs (§2.5): Luefter und Pumpe nach Temperatur gesteuert, alle Zahlen optional. */
export interface KuehlungPaket {
  status: "ok" | "fehler" | "nicht_eingerichtet";
  grund?: string;                       // Code (snake_case), nie Fehlertext
  profil_aktiv?: LuefterProfil;
  luefter?: Array<{ nr: number; ort: LuefterOrt; rpm?: number; prozent?: number }>;
  pumpe_rpm?: number; pumpe_prozent?: number; kuehlmittel_c?: number;
  leds?: "aus" | "an" | "unbekannt";
}

export interface RigPaket {
  gemessen_am: string;
  uptime_s?: number;
  cpu?: {
    temp_c?: number; temp_c_5min?: number; temp_c_max_1min?: number;
    kerne_temp_c?: [number, number]; chipsatz_temp_c?: number;
    last_prozent?: number; last_prozent_5min?: number; last_prozent_10min?: number;
    takt_mhz?: number; takt_mhz_max_kern?: number; kerne?: number; threads?: number;
    drosselung?: boolean;
    luefter_rpm?: number[] | null;
    anteil_kerne?: { ki?: number; trustone?: number };
  };
  gpu?: {
    temp_c?: number; temp_c_max_1min?: number; last_prozent?: number;
    vram_belegt_mib?: number; vram_gesamt_mib?: number; watt?: number; watt_grenze?: number;
    luefter_prozent?: number; pstate?: string; treiber?: string; takt_mhz?: number; takt_max_mhz?: number;
  };
  ram?: {
    eingebaut_gb?: number;
    module?: Array<{ platz: number; groesse_gb: number; temp_c?: number | null }>;
    gesamt_b?: number; verfuegbar_b?: number; frei_b?: number; swap_gesamt_b?: number; swap_belegt_b?: number;
    psi_full_avg10?: number; psi_some_avg10?: number; seitenfehler_s?: number;
    ki?: { belegt_b?: number; fest_b?: number; cache_b?: number; grenze_b?: number; swap_b?: number };
    trustone?: { summe_b?: number; grenze_hoch_b?: number; grenze_max_b?: number };
  };
  platten?: {
    system?: { gesamt_b: number; belegt_b: number };
    tresor?: { gesamt_b: number; belegt_b: number };
    ssd?: { status: "ok" | "nicht_verfuegbar"; temp_c?: number | null; gesundheit?: "ok" | "warnung" | "fehler" | null; abnutzung_prozent?: number | null; betriebsstunden?: number | null };
  };
  io?: { gelesen_b?: number; geschrieben_b?: number; netz_rx_b?: number; netz_tx_b?: number; vpn_rx_b?: number; vpn_tx_b?: number };
  dienste?: Array<{
    name: DienstName; zustand: "laeuft" | "startet" | "neustart" | "gestoppt";
    gesund: boolean | null; gestartet_am?: string; neustarts?: number; oom?: boolean;
    speicher_b?: number; grenze_b?: number | null;
  }>;
  kuehlung?: KuehlungPaket;
  minute?: Record<string, number>;
}

export interface KiPaket {
  version?: string; eingestellt?: string;
  instanzen?: Array<{ name: Instanz; erreichbar: boolean; version?: string; grenze_b?: number }>;
  modelle?: Array<{ name: string; groesse_b: number }>;
  geladen?: Array<{ name: string; instanz: Instanz; groesse_b: number; vram_b: number; entlaedt_am?: string }>;
  auftrag?: { art: string; seit: string; modell?: string } | null;
  warteschlange?: number;
  tempo?: { tokens_s: number; modell: string; am: string } | null;
  archiv?: { anzahl?: number; letzter_lauf?: string; neu?: number; fehler?: number; dauer_s?: number };
  tiefen_index?: { dateien?: number; nas_dateien?: number; mit_text?: number; abschnitte?: number; letzter_lauf?: string; nacht_fertig?: boolean };
  schalter?: Partial<Record<"suche" | "archiv_frage" | "hintergrund" | "lernen" | "tiefe" | "hauptmodell", boolean>>;
  hauptmodell_geladen?: boolean;
  fsm_antwort_ms?: number | null; fsm_fehler_in_folge?: number;
}

export type SnmpGrund = "zeitlimit" | "anmeldung" | "keine_antwort" | "werkzeug_fehlt" | "zugang_ungueltig" | "unbekannt";
/** Woher die NAS-Hardwarewerte kommen (§1.3 SNMP, §1.4 Mess-Container); fehlt bei «nicht_eingerichtet» ohne Zugang. */
export type HardwareQuelle = "snmp" | "exporter";
export interface NasPaket {
  gemessen_am: string;
  erreichbar: boolean; fehlversuche_in_folge: number;
  dateifreigabe?: boolean; weboberflaeche?: boolean;
  volume?: { gesamt_b: number; belegt_b: number } | null;
  freigaben?: { soll: number | null; ist: number; schreibend?: number; lesend?: number; fehlt_seit?: string | null };
  snmp: {
    status: "nicht_eingerichtet" | "ok" | "fehler"; grund?: SnmpGrund; gemessen_am?: string;
    quelle?: HardwareQuelle;
    system_temp_c?: number; cpu_temp_c?: number;
    platten?: Array<{
      schacht: number; temp_c?: number; gesundheit?: "ok" | "warnung" | "fehler";
      // nur vom Exporter (§1.4): Betriebsstunden und SMART-Rohzaehler
      betriebsstunden?: number; umgelagert?: number; ausstehend?: number; nicht_korrigierbar?: number; crc_fehler?: number;
      // nur vom Exporter (§1.4): Platte steckt nicht im Gehaeuse (USB), schacht = Geraetenummer > NAS_SCHAECHTE
      extern?: boolean;
    }>;
    raid?: "normal" | "wiederaufbau" | "degradiert" | null;
    last_prozent?: number; ram_prozent?: number; uptime_s?: number;
  };
}

export interface PaketV1 { v: 1; gesendet_am: string; rig?: RigPaket; ki?: KiPaket; nas?: NasPaket }

/** Antwort von POST /api/technik/messwerte an das Rig (§2.5): gewuenschtes Profil und seit wann. */
export interface SteuerungRig { luefter_profil: LuefterProfil; stand: string }
/** Gewuenschtes Profil fuer die Seite (technik_steuerung, Migration 318). */
export interface SteuerungStand { luefter_profil: LuefterProfil; geaendert_am: string | null }

// ---- Antwort GET /api/technik/stand (siehe §6.2) ----
export type Stufe = "gut" | "warnung" | "kritisch" | "neutral";
export type NeutralArt = "kommt" | "ruht" | "soll_offen" | "veraltet" | "info" | "nie_gemeldet" | "nicht_lesbar";
export type Bauteil = "cpu" | "gpu" | "ram" | "platten" | "dienste" | "ki" | "app" | "ablage" | "nas" | "index" | "hardware" | "backup";
export type Kachel = "rig" | "ki" | "ram" | "platten" | "nas" | "backup" | "verbindung" | "messwerte";
export type Bereich = "6h" | "24h" | "7d";

export interface Ampel {
  schluessel: string;        // z. B. "cpu.temp", "dienst.ollama_schnell"
  bauteil: Bauteil;
  kachel: Kachel | null;
  stufe: Stufe;
  neutral?: NeutralArt;      // nur bei stufe "neutral"
  titel: string;             // «Prozessor-Temperatur»
  wert: string | null;       // fertig formatiert (de-CH): «71 °C»
  text: string;              // ein Satz Klartext, ohne Fachjargon
  seit: string | null;       // ISO: seit wann diese Stufe gilt (technik_zustaende), null = gerade eben/unbekannt
  alarm: boolean;            // darf bei kritisch alarmieren (§5)
}

export interface Ereignis {
  id: string;
  zeitpunkt: string | null;  // null = «andauernd»
  stufe: "kritisch" | "warnung" | "hinweis" | "gut";
  art: "zustand" | "neustart" | "absturz" | "alarm" | "entwarnung" | "hinweis";
  bauteil: Bauteil | null;
  text: string;
}

export interface Reihen {
  bereich: Bereich;
  schritt_s: number;         // 60 (6h), 300 (24h), 3600 (7d)
  von: string; bis: string;
  // je Schluessel aus MINUTEN_SCHLUESSEL (ohne ".max"): [t_ms, mittel, spitze]
  werte: Record<string, Array<[number, number | null, number | null]>>;
  neustarts: string[];       // ISO, fuer die Luecke/Marke in den Kurven
}

export interface FsmStand {
  ki_online: boolean;
  ki_letzter_poll: string | null;
  ki_online_seit: string | null;
  ki_version: string | null;
  ki_letzter_fehler: string | null;        // gekuerzt auf 200 Zeichen
  warteschlange_offen: number;
  aeltester_offen_am: string | null;
  auftraege_24h: number;
  backup: { letzte_ok_am: string | null; letzte_meldung_am: string | null; letzte_status: "ok" | "fehler" | null;
            groesse_gesamt: string | null; groesse_db: string | null; groesse_dokumente: string | null;
            warnmails_7d: number; letzte_warnmail_am: string | null; nie_gemeldet: boolean };
  sync: { letzter_poll: string | null; intervall_s: number | null };
  index: { letzter_scan: string | null; dateien: number };
}

export interface TechnikStand {
  success: true;
  jetzt: string;
  hat_daten: boolean;                               // false = noch nie ein Paket angekommen
  gesamt: { stufe: Stufe; probleme: Ampel[] };       // probleme = warnung/kritisch, kritisch zuerst
  ampeln: Ampel[];
  rig: RigPaket | null; rig_alter_s: number | null;  // Alter = jetzt − rig.gemessen_am
  ki: KiPaket | null; ki_alter_s: number | null;
  nas: NasPaket | null; nas_alter_s: number | null;
  fsm: FsmStand;
  steuerung: SteuerungStand | null;                  // null = nicht lesbar
  ereignisse: Ereignis[];                            // neueste zuerst, Zeitraum = bereich (max. 200)
  reihen: Reihen | null;                             // nur bei ?reihen=1
}
