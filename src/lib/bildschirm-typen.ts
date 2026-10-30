// Payload des Wand-Dashboards (/api/bildschirm/daten) — reine Typen,
// damit die Client-Seite nichts Server-seitiges (crypto) importiert.

/** Ein Eintrag der Agenda (kommende Auftraege, Partner-Anfragen, Entwuerfe). */
export interface BildschirmAuftrag {
  id: string;
  typ: "auftrag" | "anfrage" | "entwurf";
  nummer: number | null;
  titel: string;
  kunde: string | null;
  ort: string | null;
  /** YYYY-MM-DD (Zurich) */
  start: string;
  ende: string;
  dringend: boolean;
  verantwortlich: string | null;
  /** Anzahl Termine am Auftrag + zugeteilte Personen (Vornamen reichen der Wand). */
  einsaetze: number;
  personen: string[];
}

export interface BildschirmWoche {
  kw: number;
  /** Montag, YYYY-MM-DD */
  start: string;
  /** Sonntag, YYYY-MM-DD */
  ende: string;
  auftraege: number;
  einsaetze: number;
}

/** Ein offenes Todo (status 'offen', nicht geloescht) — bewusst ohne
 *  Beschreibung, Anhaenge und Ersteller; Betraege im Titel maskiert. */
export interface BildschirmTodo {
  id: string;
  titel: string;
  prioritaet: "dringend" | "normal";
  /** due_date (DATE, YYYY-MM-DD) oder null */
  faellig: string | null;
  /** Aktuell zugewiesene Person (Profil), null = nicht zugewiesen. */
  person: { id: string; name: string } | null;
}

/** Ereignisarten im Fenster «Zuletzt passiert» (2026-10-11). Bewusst ohne
 *  Storniert (Kundennamen in Rot vor Besuchern), ohne «Anfrage angenommen»
 *  (accepted_at ist mehrdeutig) und ohne Betraege. */
export type BildschirmEreignisArt =
  | "auftrag_neu"
  | "partner_anfrage"
  | "einsatz_geplant"
  | "rapport"
  | "todo_erledigt"
  | "abgerechnet";

/** Ein Ereignis im Fenster «Zuletzt passiert». */
export interface BildschirmEreignis {
  /** stabil: neu:<job.id> | abger:<job.id> | rapport:<report.id> | todo:<todo.id> | einsatz:<job_id>:<tag> */
  id: string;
  art: BildschirmEreignisArt;
  /** ISO, IMMER per new Date(x).toISOString() normalisiert (einheitlich fuer Sortierung/Vergleich) */
  zeit: string;
  /** YYYY-MM-DD Zurich von zeit (localDateIso) */
  tag: string;
  /** betraegeMaskieren() angewendet */
  titel: string;
  /** voller Name einer INTERNEN Person (Avatar + Vorname) oder null —
   *  Partner-Personen erscheinen nie mit Namen. */
  person: string | null;
  /** nur partner_anfrage: Location-Name */
  ort: string | null;
  /** nur einsatz_geplant: YYYY-MM-DD Zurich des fruehesten Termins im Paket */
  einsatz_tag: string | null;
}

export interface BildschirmDaten {
  success: true;
  /** Serverzeit — die Uhr auf dem Bildschirm synchronisiert sich darauf. */
  jetzt: string;
  auftraege: BildschirmAuftrag[];
  wochen: BildschirmWoche[];
  /** Alle offenen Todos aller Personen (exakte Anzahlen, Liste hoechstens 200). */
  todos: {
    offen: number;
    /** Faellig vor heute (Zurich). */
    ueberfaellig: number;
    liste: BildschirmTodo[];
  };
  /** Letzte Ereignisse (Auswahl 30 Zurich-Tage, neueste zuerst, hoechstens 12). */
  zuletzt: {
    /** Exakte Anzahl Ereignisse der letzten 7 Zurich-Tage (inkl. heute). */
    anzahl_7_tage: number;
    /** Beginn dieses 7-Tage-Fensters (ISO, toISOString). */
    seit_7_tage: string;
    liste: BildschirmEreignis[];
  };
  kpi: {
    auftraege_geplant: number;
  };
  achtung: {
    partner_anfragen: number;
    ueberfaellige_auftraege: number;
    termine_ohne_person: number;
    rapport_entwuerfe: number;
    nicht_abgerechnet: number;
    ferien_pending: number;
    neue_belege: number;
    offene_tickets: number;
    fristen_30_tage: number;
  };
}

/** Status eines Kampagnen-Kontakts (Migration 365). */
export type VertriebStatus =
  | "offen" | "geplant" | "gesendet" | "geantwortet" | "termin"
  | "offerte" | "auftrag" | "kein_bedarf" | "unzustellbar" | "anrufen";

/** Eine Kampagne auf der Vertriebsansicht (nur Zaehler). */
export interface BildschirmKampagne {
  id: string;
  name: string;
  kontakte: number;
  geplant: number;
  /** Je angeschrieben (Erstmail raus), unabhaengig vom heutigen Status. */
  angeschrieben: number;
  /** Mindestens eine Antwort erhalten. */
  antworten: number;
  /** geantwortet + termin + offerte + auftrag + anrufen */
  im_gespraech: number;
  kein_bedarf: number;
  unzustellbar: number;
}

/** Juengste Antwort — bewusst ohne Betreff, Inhalt und Personennamen. */
export interface BildschirmAntwort {
  id: string;
  firma: string;
  kampagne: string;
  status: VertriebStatus;
  /** ISO */
  zeit: string;
}

/** Payload von /api/bildschirm/vertrieb (Leo 2026-10-30): zweite Ansicht des
 *  Buero-Bildschirms, wechselt alle 2 Minuten mit dem Firmen-Dashboard. */
export interface BildschirmVertrieb {
  success: true;
  jetzt: string;
  pipeline: {
    geplant: number;
    angeschrieben: number;
    antworten: number;
    termin: number;
    offerte: number;
    auftrag: number;
  };
  kampagnen: BildschirmKampagne[];
  antworten: BildschirmAntwort[];
  /** Fruehester geplanter Versand: Zeitpunkt, Anzahl Mails an diesem
   *  Zurich-Tag und Kampagne der ersten Mail — null, wenn nichts geplant. */
  naechste: { zeit: string; anzahl: number; kampagne: string } | null;
  achtung: {
    antworten_offen: number;
    anrufen: number;
    nachfassen: number;
    unzustellbar: number;
    geplant: number;
  };
}
