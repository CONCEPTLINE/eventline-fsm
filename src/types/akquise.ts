import type { Dreiwertig, EigentuemerTyp, ModellKey } from "@/lib/akquise-faktoren";

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
  kapazitaet: number | null;
  flaeche_m2: number | null;
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
  teilscores: { hebel: number; groesse: number; zugang: number };
  annahmen: string[];
  alternativen: ModellKey[];
  modell?: string;
  bewertet_am?: string;
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
  erstellt_am: string;
}

export interface Kooperationskonzept {
  modell: ModellKey;
  titel: string;
  /** Abschnitte in Reihenfolge — Titel plus Fliesstext. */
  abschnitte: { titel: string; text: string }[];
  /** Konkrete naechste Schritte. */
  naechste_schritte: string[];
  erstellt_am: string;
}
