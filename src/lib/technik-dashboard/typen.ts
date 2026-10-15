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
    psi_full_avg10?: number; psi_some_avg10?: number;
    // aktives Ein-/Auslagern (Bytes/s, 5-Minuten-Mittel aus /proc/vmstat pswpin/pswpout), §2.3
    swap_ein_bps_5min?: number; swap_aus_bps_5min?: number;
    ki?: { belegt_b?: number; fest_b?: number; cache_b?: number; grenze_b?: number; swap_b?: number };
    trustone?: { summe_b?: number; grenze_hoch_b?: number; grenze_max_b?: number };
    /** Wer belegt den Arbeitsspeicher fest (§2.7): KI-Modelle (llama-server), uebriger KI-Bereich, Trust one (Summe),
     *  System und uebrige Programme, verfuegbar. Nur vollstaendig. */
    belegung?: RamBelegung;
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
  /** Geladene KI-Modelle beider Ollama-Instanzen mit Rechenlast und Speicher (§2.7); leer = keines geladen. */
  ki_modelle?: KiModellLast[];
  /** Leistung der lokalen KI (§2.6): nur Zahlen, vom Sammler alle 10 min aus der Rig-DB gerechnet. */
  leistung?: LeistungRig;
  minute?: Record<string, number>;
}

// ---- Geladene KI-Modelle und Belegung des Arbeitsspeichers (§2.7, Nachtrag 15.10.2026) ----

export type KiModellRolle = "sprache" | "einbettung";

/** Ein geladenes Modell: Ollama /api/ps (Name, Groesse, davon im Grafikspeicher, Kontext, entlaedt um) und der
 *  llama-server-Prozess dazu (Rechenlast im 10-s-Mittel, Arbeitsspeicher). Ohne Prozess-Messung fehlen
 *  cpu_prozent/rechnet/rss_b/ram_b; «laedt» = Prozess laeuft, Ollama meldet das Modell noch nicht. */
export interface KiModellLast {
  instanz: Instanz;
  zustand: "geladen" | "laedt";
  name?: string;
  rolle?: KiModellRolle;
  groesse_b?: number;      // laut Ollama (Gewichte + Kontext)
  vram_b?: number;         // davon im Grafikspeicher; der Rest liegt im Arbeitsspeicher
  kontext?: number;
  entlaedt_am?: string;
  cpu_prozent?: number;    // 100 = ein Kern
  rechnet?: boolean;       // aus der Last (ab 25 %)
  rss_b?: number;          // Arbeitsspeicher des Prozesses
  ram_b?: number;          // davon fest (anonym): Gewichte im Arbeitsspeicher und Zwischenspeicher fuer Anfragen
}

export interface RamBelegung {
  ki_modelle_b: number; ki_rest_b: number; trustone_b: number; system_b: number; verfuegbar_b: number;
}

/** Was der KI-Dienst gerade selbst rechnet, ohne Auftrag aus der App (§2.7). */
export type KiHintergrund =
  | "rueckstau_zz" | "fristen" | "selbsttest" | "tiefen_index" | "vorbilder_index" | "doppel_pruefung" | "hauptmodell";

// ---- Leistung der lokalen KI (§2.6, Nachtrag 15.10.2026) ----

export type LeistungZeitraum = "7d" | "30d" | "alle";

/** Je Protokoll-Art (Rig-DB ki_protokoll): Anzahl, davon ok, Dauer der erfolgreichen (Median, laengste).
 *  Arten mit Dokument (Ablage, Belege, Rueckstau ZZ; seit 15.10.2026) dazu aus den erfolgreichen mit Seitenzahl:
 *  Rechenzeit je Seite (Median, Text / gescannt), groesstes Dokument (Seiten, Zeichen), meiste Teile. */
export interface LeistungAuftraege {
  art: string; n: number; ok: number; median_ms?: number; max_ms?: number;
  mit_seiten?: number; ms_seite_text?: number; ms_seite_gescannt?: number;
  seiten_max?: number; zeichen_max?: number; teile_max?: number;
}

/** Tiefen-Index (Rig-DB archiv_text): im Zeitraum gelesene Dateien. Zeiten seit 15.10.2026 exakt (archiv_text.dauer_ms,
 *  Dauer der Textextraktion je Datei): `gemessen` = Dateien mit Messung, je Seite nur Dateien mit Seitenzahl
 *  (gescannt: hoechstens die erkannten Seiten). Ohne `gemessen` keine Zeiten. */
export interface LeistungGelesen {
  dateien: number; mit_text?: number; gescannt?: number; seiten?: number;
  seiten_max?: number; zeichen_max?: number; mb_max?: number;
  gemessen?: number; s_seite_text?: number; s_seite_gescannt?: number; s_datei_median?: number; s_datei_max?: number;
}

/** Selbsttest der Nacht (Rig-DB selbsttest_laeufe): Anteile 0…1, mit und ohne Dateinamen. */
export interface LeistungSelbsttest {
  top1?: number; top3?: number; top1_ohne_name?: number; top3_ohne_name?: number; ms_median?: number;
}
export interface LeistungSelbsttestLauf extends LeistungSelbsttest { am: string; dateien: number }

export interface LeistungBlock {
  auftraege: LeistungAuftraege[];
  gelesen?: LeistungGelesen;
  /** Nachtarbeit Fristen (Rig-DB archiv_karte): auf Fristen gepruefte Dateien, davon mit Treffer. */
  fristen_geprueft?: { dateien: number; mit_frist: number };
  /** Mittel der Selbsttest-Laeufe im Zeitraum. */
  selbsttest?: LeistungSelbsttest & { laeufe: number };
}

export interface LeistungRig {
  stand: string;                                            // Auswertung auf dem Rig (ISO)
  seit?: string;                                            // erster Protokoll-Eintrag = Beginn der Messung
  zeitraeume: Partial<Record<LeistungZeitraum, LeistungBlock>>;
  selbsttest?: LeistungSelbsttestLauf[];                    // neueste zuerst, hoechstens 30
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
  /** Eigene Arbeit des Dienstes ohne Auftrag (Nachtarbeit, Indexe, Doppel-Pruefung, Hauptmodell); fehlt = keine. */
  hintergrund?: KiHintergrund;
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

// ---- Antwort GET /api/technik/leistung (siehe §6.5) ----

/** Entscheide ueber Ablage-Vorschlaege (Rueckstau ZZ) je Logik, gezaehlt ab deren Start. */
export interface LeistungAblage {
  logik: "lokal" | "claude";      // lokal = Regel/Vorbild/Modell auf dem Rig · claude = Rig beschreibt, Claude schlaegt vor
  seit: string | null;            // aeltester vorhandener Vorschlag (nur Reihenfolge; nie entschiedene werden beim Ersetzen geloescht)
  vorschlaege: number;            // im Zeitraum erstellt
  offen: number;                  // jetzt offen (unabhaengig vom Zeitraum)
  unveraendert: number;           // Ordner und Name wie vorgeschlagen uebernommen
  geaendert: number;              // uebernommen, aber Ordner und/oder Name geaendert
  ordner_geaendert: number;
  name_geaendert: number;
  abgelehnt: number;
  entscheid_von: string | null;   // erster/letzter Entscheid im Zeitraum
  entscheid_bis: string | null;
}

/** Ablagen aus der App (Upload, Mail-Eingang) mit KI-Vorschlag im Zeitraum (ablage_items.ki_*, Migration 339). */
export interface LeistungUploads {
  seit: string | null;            // erste Ablage mit festgehaltenem Vorschlag
  mit_vorschlag: number;
  unveraendert: number;           // Ordner UND Name wie vorgeschlagen
  ordner_geaendert: number;       // auch: kein Ordner vorgeschlagen
  name_geaendert: number;         // auch: kein vollstaendiger Namensvorschlag (ohne Betreff)
  /** Woher der Vorschlag kam: Regel / lokale KI / Claude (Dokument gelesen) bzw. getippter Beschrieb (Claude). */
  quellen: { regel: number; lokal: number; claude: number; beschrieb: number };
}

/** Groesstes Dokument (Seiten), dessen vorgeschlagener Ordner uebernommen wurde — App oder Rueckstau ZZ. */
export interface LeistungGroesstes { seiten: number; herkunft: "app" | "zz"; am: string }

export interface TechnikLeistung {
  success: true;
  jetzt: string;
  zeitraum: LeistungZeitraum;
  von: string | null;             // Beginn des Zeitraums (null = gesamt)
  rig: { stand: string; seit: string | null; block: LeistungBlock | null; selbsttest: LeistungSelbsttestLauf[] } | null;
  ablage: LeistungAblage[];
  uploads: LeistungUploads;
  groesstes: LeistungGroesstes | null;
  fristen: { seit: string | null; gefunden: number; bestaetigt: number; verworfen: number; offen: number };
  sicherheit: { seit: string | null; rapporte: number };
}
