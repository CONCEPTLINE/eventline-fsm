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

export interface BildschirmTag {
  /** YYYY-MM-DD (Zurich) */
  datum: string;
  termine: BildschirmTermin[];
}

export interface BildschirmAuslastung {
  datum: string;
  termine: number;
  personen: number;
}

export interface BildschirmDaten {
  success: true;
  /** Serverzeit — die Uhr auf dem Bildschirm synchronisiert sich darauf. */
  jetzt: string;
  heute: BildschirmTermin[];
  tage: BildschirmTag[];
  auslastung: BildschirmAuslastung[];
  team: TeamMemberStatus[];
  kpi: {
    offene_auftraege: number;
    geplante_termine_woche: number;
    nicht_abgerechnet: number;
    im_einsatz: number;
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
