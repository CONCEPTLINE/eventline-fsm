// Antwort von GET /api/dashboard — reine Typen, geteilt zwischen Route und
// Seite (die Client-Seite zieht damit nichts Server-seitiges mit).

import type { DashboardBereichKey } from "@/lib/dashboard-bereiche";
import type {
  AufmerksamkeitDaten,
  KennzahlenDaten,
  NaechsteDaten,
  NaechsterAuftrag,
  TeamMemberStatus,
} from "@/lib/dashboard-admin-data";

export type { AufmerksamkeitDaten, KennzahlenDaten, NaechsteDaten, NaechsterAuftrag, TeamMemberStatus };

export interface TeamDaten {
  /** "team" = nur das eigene Team (Titel «Mein Team»), "alle" = firmenweit. */
  sicht: "team" | "alle";
  personen: TeamMemberStatus[];
}

export interface NaechsterEinsatz {
  id: string;
  /** ISO timestamptz */
  start: string;
  ende: string | null;
  job_id: string | null;
  auftrag_nr: number | null;
  /** Auftragstitel (bei Terminen ohne Auftrag: Termintitel). */
  titel: string;
  /** Termintitel, wenn er etwas anderes sagt als der Auftragstitel
   *  (z. B. «Security Teamleiter» im Auftrag «BAZAR 2026»). */
  aufgabe: string | null;
  /** Location- bzw. Raumname. */
  ort: string | null;
  /** Externe Adresse, wenn keine Location/kein Raum hinterlegt ist. */
  adresse: string | null;
}

export interface EinsatzDaten {
  naechster: NaechsterEinsatz | null;
}

export interface MonatDaten {
  /** YYYY-MM (Zurich) */
  monat: string;
  /** Heutiger Tag im Monat (Zurich) und Anzahl Tage des Monats. */
  tag: number;
  tage_im_monat: number;
  /** Gestempelte Stunden bisher in diesem Monat. */
  stunden: number;
  /** Bisher + noch geplante Einsaetze bis Monatsende. */
  prognose_stunden: number;
  /** Netto-Prognose in CHF; null = kein Lohn hinterlegt (lohnbefreit oder ohne Stundensatz). */
  prognose_chf: number | null;
}

export interface DashboardDaten {
  success: true;
  vorname: string;
  /** Sichtbare Bereiche (Rechte + Rollen-Schalter). Das Layout ist fest. */
  bereiche: DashboardBereichKey[];
  kennzahlen: KennzahlenDaten | null;
  aufmerksamkeit: AufmerksamkeitDaten | null;
  team: TeamDaten | null;
  naechste: NaechsteDaten | null;
  einsatz: EinsatzDaten | null;
  monat: MonatDaten | null;
}
