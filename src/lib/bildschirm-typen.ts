// Payload des Wand-Dashboards (/api/bildschirm/daten) — reine Typen,
// damit die Client-Seite nichts Server-seitiges (crypto) importiert.

import type { TeamMemberStatus } from "@/lib/dashboard-admin-data";

export interface BildschirmTermin {
  id: string;
  titel: string;
  /** ISO timestamptz */
  start: string;
  ende: string | null;
  zeit_modus: "fix" | "verschiebbar" | "deadline" | null;
  auftrag_nr: number | null;
  auftrag_titel: string;
  ort: string | null;
  kunde: string | null;
  /** Alle zugeteilten Personen (gleicher Termin bei mehreren Personen = eine Zeile). */
  personen: { id: string; name: string }[];
}

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

export interface BildschirmDaten {
  success: true;
  /** Serverzeit — die Uhr auf dem Bildschirm synchronisiert sich darauf. */
  jetzt: string;
  heute: BildschirmTermin[];
  /** Naechster Einsatz ab jetzt (fuer den leeren Heute-Zustand). */
  naechster: BildschirmTermin | null;
  auftraege: BildschirmAuftrag[];
  wochen: BildschirmWoche[];
  team: TeamMemberStatus[];
  kpi: {
    im_einsatz: number;
    auftraege_geplant: number;
    einsaetze_7_tage: number;
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
