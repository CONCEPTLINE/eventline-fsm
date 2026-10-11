import type { Dreiwertig, EigentuemerTyp, FlaechenArt, KonzeptKennzahlen, ModellKey, Traeger } from "@/lib/akquise-faktoren";

/** Eine Zeile aus `akquise_locations` (Migration 295). */
export interface AkquiseLocation {
  id: string;
  nr: number;
  name: string;
  typ: string | null;
  strasse: string | null;
  plz: string | null;
  ort: string;
  kanton: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  email: string | null;
  telefon: string | null;
  /** Migration 297 — aus der Website gelesen, nicht geschätzt. */
  ansprechperson: string | null;
  position: string | null;
  /** URL, auf der Ansprechperson/Kontakt belegt sind. Leer = nicht belegt. */
  kontakt_quelle: string | null;
  angereichert_am: string | null;
  /** Was die Website über die Vermietung sagt. */
  vermietung_hinweis: string | null;
  /** Migration 298 — wie besetzt das Haus ist. Entscheidet mit, ob
   *  EVENTLINE überhaupt hineinkommt. */
  techniker_im_team: number | null;
  technikpartner: "ja" | "nein" | "unklar" | null;
  technikpartner_name: string | null;
  team_beschreibung: string | null;
  geschaeftsstruktur: string | null;
  /** Dossier aus der Website-Recherche. */
  recherche: Recherche | null;
  kapazitaet: number | null;
  flaeche_m2: number | null;
  /** Migration 296: wofür die Fläche da ist — entscheidet über den Bedarf. */
  flaeche: FlaechenArt;
  /** Migration 299: stehen Zeitfenster real leer? Bedingung für Modell A. */
  zeitfenster_frei: Dreiwertig;
  /** Monatsmiete der Liegenschaft — Grundlage der Tarifrechnung. */
  monatsmiete_chf: number | null;
  /** A ab 3.8, B ab 3.0, sonst C. */
  prioritaet: "A" | "B" | "C" | null;
  /** Migration 300: Projekt, das aus diesem Kandidaten entstanden ist. */
  projekt_id: string | null;
  eigene_vermarktung: Dreiwertig;
  personal_vor_ort: Dreiwertig;
  technik_vorhanden: Dreiwertig;
  eigentuemer_typ: EigentuemerTyp;
  empfohlenes_modell: ModellKey | null;
  rentabilitaet_chf: number | null;
  score: number | null;
  bewertung: AkquiseBewertungJson | null;
  quelle: "osm" | "manuell" | "ki";
  osm_id: string | null;
  recherchiert_am: string | null;
  angepinnt_am: string | null;
  angepinnt_von: string | null;
  bedarfsanalyse: Bedarfsanalyse | null;
  kooperationskonzept: Kooperationskonzept | null;
  notizen: string | null;
  created_at: string;
  updated_at: string;
}

/** Inhalt der `bewertung`-Spalte — Begruendung und Annahmen der Einschaetzung. */
export interface AkquiseBewertungJson {
  begruendung: string;
  /** Satz der KI, worauf sie ihre Schaetzung stuetzt. */
  ki_einschaetzung?: string;
  /** Die fünf Kriterien des Auftrags, je 1–5. */
  teilscores: {
    raumpotenzial: number;
    zeitfenster: number;
    entlastungsbedarf: number;
    modellpassung: number;
    erreichbarkeit: number;
  };
  /** Gewichteter Gesamtwert 1–5. */
  gesamt?: number;
  prioritaet?: "A" | "B" | "C";
  annahmen: string[];
  alternativen: ModellKey[];
  modell?: string;
  bewertet_am?: string;
}

/** Was die Website über das Haus hergibt — nichts davon ist geschätzt. */
export interface Recherche {
  raeume: { name: string; kapazitaet: number | null; flaeche_m2: number | null; eignung: string | null }[];
  infrastruktur: string[];
  preis_hinweis: string | null;
  preise_oeffentlich: boolean;
  veranstaltungstypen: string[];
  betrieb_seit: string | null;
  besonderheiten: string | null;
  /** Belegt, woher die Angaben stammen. */
  gelesene_seiten: { url: string; zweck: string }[];
  /** Was NICHT auf der eigenen Website steht — aus der Websuche. */
  umfeld?: {
    befunde: {
      aussage: string;
      quelle: string;
      datum: string | null;
      kategorie: "presse" | "finanzierung" | "personal" | "veraenderung" | "partner" | "auslastung";
      relevanz: "hoch" | "mittel" | "gering";
    }[];
    gespraechseinstieg: string | null;
    recherchiert_am: string;
  };
}

/** Detaillierte Bedarfsanalyse — Grundlage fuer PDF und Konzept. */
export interface Bedarfsanalyse {
  ausgangslage: string;
  /** Was der Location konkret fehlt. */
  luecken: string[];
  /** Was EVENTLINE davon abdeckt. */
  unser_beitrag: string[];
  risiken: string[];
  /** Offene Fragen fuer das Erstgespraech. */
  offene_fragen: string[];
  /** Welches Vertragsgesicht hier passt — GmbH oder Verein KULTURLINE —
   *  und ob dessen Fonds für dieses Haus ein Hebel wäre. */
  traeger_einschaetzung?: string;
  erstellt_am: string;
}

export interface Kooperationskonzept {
  modell: ModellKey;
  /** Wer unterschreibt — Verein KULTURLINE oder EVENTLINE GmbH. Betrieb
   *  und Administration macht in beiden Fällen die EVENTLINE GmbH. */
  traeger: Traeger;
  traeger_begruendung: string;
  /** Berechnet, nicht vom Modell geschätzt. null = keine Grundlage. */
  kennzahlen: KonzeptKennzahlen | null;
  titel: string;
  /** Ein Satz: wer macht was, und was hat die Location davon. */
  untertitel: string;
  /** Abschnitte in Reihenfolge — Titel plus Fliesstext. */
  abschnitte: { titel: string; text: string }[];
  /** Konkrete naechste Schritte. */
  naechste_schritte: string[];
  erstellt_am: string;
}
