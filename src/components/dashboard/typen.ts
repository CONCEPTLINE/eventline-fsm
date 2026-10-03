// Antwort von GET /api/dashboard — reine Typen, geteilt zwischen Route und
// Seite (die Client-Seite zieht damit nichts Server-seitiges mit).

import type { JobPriority, Todo } from "@/types";
import type { DashboardBereichKey } from "@/lib/dashboard-bereiche";
import type {
  AufmerksamkeitDaten,
  KennzahlenDaten,
  NaechsteDaten,
  NaechsterAuftrag,
  TeamMemberStatus,
} from "@/lib/dashboard-admin-data";

export type { AufmerksamkeitDaten, KennzahlenDaten, NaechsteDaten, NaechsterAuftrag, TeamMemberStatus };

export interface TodoEintrag {
  id: string;
  title: string;
  /** YYYY-MM-DD (Spalte DATE); null = ohne Datum. */
  due_date: string | null;
  priority: JobPriority;
  /** Vom Server immer «offen» — «erledigt» nur lokal nach dem Abhaken
   *  (todo-stand.ts), bis die naechste Antwort die Todo nicht mehr bringt. */
  status: Todo["status"];
}

export interface TodosDaten {
  /** Hoechstens 6 eigene offene Todos: ueberfaellig, heute, spaeter (Datum
   *  aufsteigend), ohne Datum (neueste zuerst) — je Gruppe «dringend» zuerst. */
  eintraege: TodoEintrag[];
  /** Alle eigenen offenen Todos (dieselbe Menge wie der Sidebar-Zaehler). */
  offen: number;
  /** Davon faellig: ueberfaellig oder heute (Zurich). */
  faellig: number;
  /** Davon ueberfaellig. */
  ueberfaellig: number;
}

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
  todos: TodosDaten | null;
  team: TeamDaten | null;
  naechste: NaechsteDaten | null;
  einsatz: EinsatzDaten | null;
  monat: MonatDaten | null;
}
