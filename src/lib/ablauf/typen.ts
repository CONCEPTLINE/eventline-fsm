// Gemeinsame Typen des Vermietungs-Ablaufs (Etappe 2, docs/barakuba/VERTRAG-ABLAUF.md).
// Eine Zeile in auftrag_ablauf schaltet bei einem normalen Location-Auftrag die
// Ablauf-Ansicht ein (5 Schritte, Mail-Erkennung, Vertrag, Übergabe).
// Rein (keine Server-Imports) — von Backend, Dokumente-Agent und UI genutzt.

export type SchrittNr = 1 | 2 | 3 | 4 | 5;

export const SCHRITTE: readonly { nr: SchrittNr; titel: string; kurz: string }[] = [
  { nr: 1, titel: "Anfrage & Konditionen", kurz: "Anfrage" },
  { nr: 2, titel: "Bestätigung", kurz: "Bestätigung" },
  { nr: 3, titel: "Vertrag & Pollerformular", kurz: "Vertrag" },
  { nr: 4, titel: "Vertrag unterschrieben", kurz: "Unterschrift" },
  { nr: 5, titel: "Übergabe erfolgt", kurz: "Übergabe" },
];

export const AUFTRAG_MAIL = "auftrag@in.eventline-basel.com";

/** Felder aus Basils «Vorbesprechung»-Formular (= `Felder` der Skizze daten.ts).
 *  Texte leer = unbekannt; datum ISO yyyy-mm-dd, beginn HH:MM. */
export interface AblaufFelder {
  datum: string;
  mieter: string;
  telefon: string;
  adresse: string;
  email: string;
  anlass: string;
  beginn: string;
  gaeste: string;
  catering: string;
  programm: string;
  stellwand: string;
  bier: boolean;
  buffettisch: boolean;
  vorhang: boolean;
  tonanlage: boolean;
  djMischpult: boolean;
  disco: boolean;
  buehneLicht: boolean;
  pollerName: string;
  pollerMobil: string;
  komplettservice: boolean;
  /** Komplettservice ist individuell — freier Preis, leer = keine Kosten-Zeile. */
  preisKomplettservice: string;
  bemerkungen: string;
}

export type FeldName = keyof AblaufFelder;

export const TEXT_FELDER = [
  "datum", "mieter", "telefon", "adresse", "email", "anlass", "beginn", "gaeste", "catering",
  "programm", "stellwand", "pollerName", "pollerMobil", "preisKomplettservice", "bemerkungen",
] as const satisfies readonly FeldName[];

export const BOOL_FELDER = [
  "bier", "buffettisch", "vorhang", "tonanlage", "djMischpult", "disco", "buehneLicht", "komplettservice",
] as const satisfies readonly FeldName[];

export const FELDER_LEER: AblaufFelder = {
  datum: "", mieter: "", telefon: "", adresse: "", email: "", anlass: "", beginn: "", gaeste: "",
  catering: "", programm: "", stellwand: "", bier: false, buffettisch: false, vorhang: false,
  tonanlage: false, djMischpult: false, disco: false, buehneLicht: false, pollerName: "",
  pollerMobil: "", komplettservice: false, preisKomplettservice: "", bemerkungen: "",
};

/** Arbeitsstand der Übergabe — liegt ebenfalls in auftrag_ablauf.felder (Schlüssel `uebergabe_haken`,
 *  `poller_freigeschaltet`), gehört aber NICHT zu den Formularfeldern: die Mail-KI liest/setzt ihn nie,
 *  geändert nur per PATCH (Mensch). Haken = Texte aus UEBERGABE_LISTE bzw. «inv:<Inventar>». */
export interface AblaufArbeit {
  uebergabe_haken: string[];
  poller_freigeschaltet: boolean;
}

export const ARBEIT_LEER: AblaufArbeit = { uebergabe_haken: [], poller_freigeschaltet: false };

/** Wer ein Feld zuletzt gesetzt hat. «manuell» überschreibt die KI nie. */
export type FeldQuelle = "mail" | "manuell";

/** Zeile auftrag_ablauf (aufbereitet: felder vollständig, Herkunft separat). */
export interface Ablauf {
  job_id: string;
  /** aktueller Schritt = kleinster nicht erledigter (alle erledigt → 5) */
  schritt: SchrittNr;
  erledigt: SchrittNr[];
  felder: AblaufFelder;
  /** Herkunft je gesetztem Feld (in der DB unter felder._quelle) */
  feld_quelle: Partial<Record<FeldName, FeldQuelle>>;
  /** abgehakte Punkte der Übergabe-Liste/des Inventars (in der DB unter felder.uebergabe_haken) */
  uebergabe_haken: string[];
  /** Poller-Nummer freigeschaltet (in der DB unter felder.poller_freigeschaltet) */
  poller_freigeschaltet: boolean;
  /** Zusage des Kunden → intern im Kalender (Status 'offen') */
  fixiert_am: string | null;
  /** ab hier im Partner-Kalender für Basil sichtbar */
  unterschrieben_am: string | null;
  uebergabe_person_id: string | null;
  uebergabe_start: string | null;
  vertrag_dokument_id: string | null;
  abgeschlossen_am: string | null;
  created_at: string;
  updated_at: string;
}

export type EreignisQuelle = "mail" | "manuell" | "system";

/** Was ein Ereignis bewirkt hat — Grundlage für «Rückgängig» (Spalte wirkung jsonb). */
export interface AblaufWirkung {
  /** Schritte, die dieses Ereignis auf erledigt gesetzt hat */
  erledigt_plus?: SchrittNr[];
  /** Schritte, die dieses Ereignis zurückgenommen hat */
  erledigt_minus?: SchrittNr[];
  /** Zusage: vorher nicht fixiert; Auftragsstatus vorher */
  fixiert?: { status_vorher: string | null };
  /** unterschrieben_am gesetzt (vorher null) */
  unterschrieben?: true;
  /** unterschrieben_am entfernt: Wert vorher */
  unterschrieben_entfernt?: string;
  /** Felder vorher / gesetzt (nur die geänderten) */
  felder_vorher?: Partial<AblaufFelder>;
  felder_neu?: Partial<AblaufFelder>;
  quelle_vorher?: Partial<Record<FeldName, FeldQuelle | null>>;
  /** Dokumente, die in den Ordner «Vertrag» gelegt wurden (unterschriebener Vertrag) */
  dokument_ids?: string[];
}

/** Zeile auftrag_ablauf_ereignisse (für den Verlauf). */
export interface AblaufEreignis {
  id: string;
  job_id: string;
  zeit: string;
  text: string;
  /** setzt diesen Schritt erledigt (Anzeige) */
  schritt: SchrittNr | null;
  quelle: EreignisQuelle;
  auftrag_mail_id: string | null;
  rueckgaengig_am: string | null;
  erstellt_von: string | null;
  erstellt_von_name: string | null;
  /** true = hat eine Wirkung und ist noch nicht zurückgenommen */
  ruecknehmbar: boolean;
}

/** Einordnung einer Mail zu einem Auftrag MIT Ablauf (KI). */
export type MailArt =
  | "konditionen_an_kunde"
  | "zusage_kunde"
  | "bestaetigung_an_kunde"
  | "vertrag_an_kunde"
  | "vertrag_unterschrieben"
  | "felder_ergaenzung"
  | "sonstiges";

export const MAIL_ARTEN: readonly MailArt[] = [
  "konditionen_an_kunde", "zusage_kunde", "bestaetigung_an_kunde", "vertrag_an_kunde",
  "vertrag_unterschrieben", "felder_ergaenzung", "sonstiges",
];

/** Mail des Auftrags (auftrag_mails + Auszug aus dem Eingang). */
export interface AblaufMail {
  id: string;
  empfangen_am: string;
  absender: string | null;
  cc: string[];
  betreff: string | null;
  /** aus = Absender @eventline-basel.com */
  richtung: "ein" | "aus";
  /** Anfang des Mailtexts (aus dem Eingang), null wenn nicht vorhanden */
  auszug: string | null;
  anhaenge: string[];
  zuordnung: string | null;
}

/** EVENTLINE-Person, die der Location zugeteilt ist (standort_mitarbeiter), am Veranstaltungstag. */
export interface AblaufPerson {
  id: string;
  name: string;
  telefon: string | null;
  frei: boolean;
  /** warum nicht frei (Ferien, Krank, Einsatz <Location>) */
  grund: string | null;
}

/** GET /api/jobs/[id]/ablauf */
export interface AblaufAntwort {
  ablauf: Ablauf;
  ereignisse: AblaufEreignis[];
  mails: AblaufMail[];
  personal: AblaufPerson[];
}

/** PATCH /api/jobs/[id]/ablauf */
export interface AblaufPatch {
  felder?: Partial<AblaufFelder>;
  uebergabe_person_id?: string | null;
  /** ISO-Zeitpunkt; null = entfernen */
  uebergabe_start?: string | null;
  /** vollständige Liste der abgehakten Übergabe-/Inventar-Punkte */
  uebergabe_haken?: string[];
  poller_freigeschaltet?: boolean;
}

/** POST /api/jobs/[id]/ablauf/schritt */
export interface SchrittAktion {
  aktion: "erledigt" | "zurueck";
  schritt: SchrittNr;
}

/** Übergabe: 1 h ab 14:00 am Veranstaltungstag (Europe/Zurich). */
export const UEBERGABE_STANDARD = { stunde: 14, minute: 0, dauerMin: 60 } as const;
