/**
 * Geteilte Types fuer Monat-/Wochenansicht. Beide Views konsumieren die
 * gleichen Strukturen — Page-Controller laedt einmal, gibt's jeweils weiter.
 */

export type ItemType = "auftrag" | "vermietung" | "entwurf" | "projekt";

/** Mehrtages-Item (Auftrag oder Vermietung). Im Monat wird's als Stripe ueber
 *  alle berührten Tage gerendert; in der Woche als Bar in der Top-Section. */
export interface CalendarItem {
  id: string;
  type: ItemType;
  /** Auftrag-Nr (INT-XXXXX). Bei beiden Typen als Prefix im Title sichtbar. */
  jobNumber: number | null;
  /** Bevorzugter Anzeige-Titel:
   *   - Auftrag:    "INT-12345 | Konzert Stadthalle"
   *   - Vermietung: "INT-12346 | Müller" (Kunde-Name als Body) */
  title: string;
  date: Date;
  endDate?: Date;
  customerName: string | null;
  locationName: string | null;
  href: string;
}

/** Einzel-Termin (Schicht). Bezug zum Auftrag via jobType + jobId — bestimmt
 *  in der Woche die FARBE (rot=Auftrag, hellblau=Vermietung, grau=ohne Job).
 *  Die Job-Nr-Badge gibt's als zweiten Anker fuer "welche Termin gehoert
 *  zu welchem Auftrag". */
export interface CalendarShift {
  id: string;
  jobId: string | null;
  jobType: ItemType | null;
  jobNumber: number | null;
  jobTitle: string | null;
  /** Schichten haben immer eine Uhrzeit (start_time). Date enthaelt sie. */
  date: Date;
  endDate?: Date;
  title: string;
  assigneeName: string | null;
  /** Profile-ID des Zugewiesenen — fuer Lookup BVG-Forecast pro Person. */
  assigneeId: string | null;
  /** Falls dem Termin ein Job zugeordnet ist, fuehrt der Klick auf den
   *  Termin zur Auftrag-Detail-Page; ohne Job nicht klickbar. */
  href: string | null;
  /** Optionaler Teams/Zoom/Meet-Link. Wird in der Detail-Seitenleiste
   *  als kleines Video-Icon angezeigt — direkter Join-Button. */
  meetingLink: string | null;
}

/** BVG-Forecast pro Person fuer den aktuell sichtbaren Monat (Schichtplan). */
export interface BvgPersonForecast {
  chf: number;
  threshold: number;
  status: "ok" | "warn" | "crit";
}

/** Genehmigte Abwesenheit (time_off) — wird in beiden Views dezent als
 *  kleiner Marker pro Tag/Person gerendert. RLS scoped Non-Admins eh auf
 *  eigene, Admins sehen alle. */
export interface CalendarTimeOff {
  id: string;
  userId: string;
  userName: string;
  type: "ferien" | "krank" | "kompensation" | "frei" | "militaer";
  startDate: Date;
  endDate: Date;
}

export type CalendarView = "monat" | "woche";
