// Hauptrollen — die Praesenz von 'partner' hier ist wichtig damit der
// Path-Guard im (app)-Layout den Partner-Redirect typsicher pruefen kann.
// In der DB ist roles eine eigene Tabelle mit beliebig vielen slugs;
// dieser Type ist nur die "bekannten" Rollen fuer Compile-time-Branching.
export type UserRole = "admin" | "techniker" | "partner";

export type JobStatus = "partner_anfrage" | "anfrage" | "entwurf" | "offen" | "abgeschlossen" | "storniert";

export type JobPriority = "normal" | "dringend";

export type CustomerType = "company" | "individual" | "organization";


export type ReportStatus = "entwurf" | "abgeschlossen";

export type TimeOffType = "ferien" | "krank" | "kompensation" | "frei" | "militaer";
export type TimeOffStatus = "beantragt" | "genehmigt" | "abgelehnt";

export interface TimeOff {
  id: string;
  user_id: string;
  start_date: string; // YYYY-MM-DD
  end_date: string;
  type: TimeOffType;
  status: TimeOffStatus;
  note: string | null;
  approved_by: string | null;
  approved_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: UserRole;
  avatar_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  /** Geburtsdatum YYYY-MM-DD. Wird fuer Ferienanteil-Auto-Erkennung
   *  gebraucht (U20 -> 10.64%). Sensible Daten, nur Admins lesen. */
  birthdate?: string | null;
}

export interface Customer {
  id: string;
  name: string;
  type: CustomerType;
  email: string | null;
  phone: string | null;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
  /** ISO-2-Land-Code, z.B. 'CH', 'DE'. Default 'CH'. Wird per Google-Maps-
   *  Autocomplete automatisch befuellt, kann manuell ueberschrieben werden. */
  address_country: string;
  /** Verknuepfung zu Bexio-Kontakt (interne Bexio-ID). Gesetzt sobald Sync erfolgt. */
  bexio_contact_id: string | null;
  /** Menschenlesbare Bexio-Kundennummer (z.B. "21001"). Sichtbar in der UI,
   *  damit Eventline und Bexio dieselbe Nummer fuehren. NULL bis Sync passiert. */
  bexio_nr: string | null;
  notes: string | null;
  is_active: boolean;
  /** Wenn gesetzt: Kunde ist im Archiv. Standard-Listen filtern auf NULL.
   *  Auto-archiviert nach 1 Jahr ohne neuen Auftrag (siehe /api/customers/auto-archive). */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Location {
  id: string;
  name: string;
  address_street: string | null;
  address_zip: string | null;
  address_city: string;
  capacity: number | null;
  customer_id: string | null;
  notes: string | null;
  technical_details: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  job_number: number | null;
  title: string;
  description: string | null;
  status: JobStatus;
  priority: JobPriority;
  /** 'location' = Auftrag in unserem Standort (location_id gesetzt, customer_id i.d.R. NULL,
   *  Verwaltungs-Kunde kommt ueber locations.customer_id).
   *  'extern'   = Auftrag fuer externen Kunden — entweder room_id (bekannter Raum)
   *  oder external_address (freie Adresse) ist gesetzt. */
  job_type: "location" | "extern";
  /** Bei location-Auftraegen typisch NULL — der Verwaltungs-Kunde aus
   *  locations.customer_id ist die Quelle der Wahrheit. Bei extern-Auftraegen Pflicht. */
  customer_id: string | null;
  location_id: string | null;
  /** Bei job_type='extern': optional ein bekannter Raum aus der rooms-Tabelle.
   *  Wenn gesetzt, wird die Adresse vom Raum gezogen — sonst external_address als Freitext. */
  room_id: string | null;
  /** Freie Adresse fuer extern-Auftraege ohne hinterlegten Raum. */
  external_address: string | null;
  project_lead_id: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  is_deleted: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Anfrage-Phase (gefuellt wenn status='anfrage')
  request_step: 1 | 2 | 3 | 4 | 5 | null;
  event_type: string | null;
  guest_count: number | null;
  extended_services: string | null;
  // Bleibt TRUE auch nach Konvertierung/Stornierung — fuer Lifecycle-Auswertung der Mietanfragen
  was_anfrage: boolean;
  // Veranstalter-Kontakt — pro-Auftrag (kann pro Event variieren auch bei
  // gleichem Kunden). UI: Person + Phone Pflicht, Mail optional.
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  // Storno-Metadaten — gefuellt wenn status='storniert'
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  // TRUE wenn die Stornierung in der Anfrage-Phase passierte — solche Jobs gehoeren nicht ins Auftrags-Archiv.
  cancelled_as_anfrage: boolean;
  // Abrechnung — gefuellt wenn der Auftrag als "Rechnung gestellt" markiert wurde.
  // /abrechnung filtert auf status='abgeschlossen' AND invoiced_at IS NULL
  // AND invoice_skipped_at IS NULL.
  // /auftraege-Archiv zeigt invoiced_at IS NOT NULL als "Abgerechnet"-Tag,
  // bzw. invoice_skipped_at IS NOT NULL als "Keine Rechnung"-Tag.
  invoiced_at: string | null;
  invoice_number: string | null;
  invoiced_by: string | null;
  // "Rechnung nicht gestellt" — exklusiv zu invoiced_at (DB-Constraint).
  invoice_skipped_at: string | null;
  invoice_skipped_reason: string | null;
  invoice_skipped_by: string | null;
  // Partner-Anfrage Custom-Felder (Block-Antworten ohne mapTo, jsonb keyed by block.id).
  // Wird via PartnerFormAnswersCard auf der Detail-Page gerendert.
  form_answers: Record<string, unknown> | null;
  // Schema-Snapshot zum Submit-Zeitpunkt — stabilisiert das Label-Lookup
  // wenn der Admin das Form spaeter aendert (sonst wandern Antworten
  // in "(Feld gelöscht)").
  form_schema_snapshot: import("@/lib/partner-form/types").FormSchema | null;
  // Joined data
  customer?: Customer;
  location?: Location;
  room?: Room;
  project_lead?: Profile;
  appointments?: JobAppointment[];
  cancelled_by_profile?: { full_name: string };
}

// === Join-Shapes fuer Supabase-Query-Resultate ===
// Wenn man `.select("*, customer:customers(name, email), ...")` macht, liefert
// Supabase nur die expliziten Felder. Das full Customer-Interface waere ein
// Lie. Deshalb hier schmale Join-Typen die genau das beschreiben was die
// jeweilige Query selektiert.
//
// Vorher: ueberall `as unknown as { name: string }` Casts. Nachher: ein paar
// klar benannte Typen die du in der Query und im Render-Code wiederverwendest.

/** Was wir typisch in Listen- und Detail-Joins vom Customer selektieren. */
export type JobCustomerSummary = Pick<
  Customer,
  | "id"
  | "name"
  | "email"
  | "address_street"
  | "address_zip"
  | "address_city"
  | "address_country"
  | "bexio_contact_id"
>;

/** Verwaltungs-Kunde eines Standorts — wird ueberall mitgejoint, damit
 *  Location-Auftraege (jobs.customer_id = NULL) trotzdem einen Kundennamen
 *  anzeigen koennen (= der Standort-Betreiber, der die Rechnung bekommt). */
export type LocationAdminCustomer = Pick<Customer, "id" | "name">;

/** Was wir typisch vom Location-Join selektieren. Inkludiert immer den
 *  Verwaltungs-Kunden, sodass die UI ueberall denselben Fallback anwenden kann. */
export type JobLocationSummary = Pick<
  Location,
  "id" | "name" | "address_street" | "address_zip" | "address_city"
> & {
  customer: LocationAdminCustomer | null;
};

/** Was wir typisch vom Room-Join selektieren. Spiegelt Location-Summary fuer
 *  konsistente Adress-Anzeige (das gleiche Pattern in Liste + Detail). */
export type JobRoomSummary = Pick<
  Room,
  "id" | "name" | "address_street" | "address_zip" | "address_city"
>;

/** Job + joined customer/location/room/appointments wie auf der Auftrags-Liste.
 *  Location-Join inkludiert id+name und den Verwaltungs-Kunden (Fallback). */
export type JobWithRelations = Omit<Job, "customer" | "location" | "room" | "appointments"> & {
  customer: JobCustomerSummary | null;
  location: (Pick<Location, "id" | "name"> & { customer: LocationAdminCustomer | null }) | null;
  room: Pick<Room, "id" | "name"> | null;
  appointments?: Pick<JobAppointment, "id" | "start_time" | "assigned_to">[] | null;
};

/** Job + reichere Joins fuer die Auftrags-Detail-Seite. */
export type JobDetailWithRelations = Omit<
  Job,
  "customer" | "location" | "room" | "project_lead" | "cancelled_by_profile"
> & {
  customer: JobCustomerSummary | null;
  location: JobLocationSummary | null;
  room: JobRoomSummary | null;
  project_lead: { full_name: string } | null;
  cancelled_by_profile: { full_name: string } | null;
};

export interface JobAppointment {
  id: string;
  job_id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  assignee?: Profile;
}


export interface ServiceReport {
  id: string;
  job_id: string;
  created_by: string;
  report_date: string;
  work_description: string;
  equipment_used: string | null;
  issues: string | null;
  client_name: string | null;
  signature_url: string | null;
  technician_name: string | null;
  technician_signature_url: string | null;
  status: ReportStatus;
  pdf_url: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  job?: Job;
  photos?: ReportPhoto[];
  creator?: Profile;
}

export interface ReportPhoto {
  id: string;
  report_id: string;
  storage_path: string;
  caption: string | null;
  sort_order: number;
  created_at: string;
}

export interface Document {
  id: string;
  name: string;
  storage_path: string;
  file_size: number | null;
  mime_type: string | null;
  job_id: string | null;
  location_id: string | null;
  customer_id: string | null;
  uploaded_by: string;
  created_at: string;
}

// RentalRequest-Type entfernt — Vermietungsanfragen sind jetzt jobs mit
// status='anfrage' und request_step 1..5 (siehe REQUEST_STEPS in constants.ts).

export interface LocationContact {
  id: string;
  location_id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
}

// Stempel-System: ein Eintrag pro Einstempel-Vorgang. clock_out=NULL
// = Eintrag laeuft noch. job_id ODER description ist immer gefuellt
// (DB-Constraint).
export interface TimeEntry {
  id: string;
  user_id: string;
  job_id: string | null;
  clock_in: string;
  clock_out: string | null;
  description: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceTask {
  id: string;
  location_id: string;
  title: string;
  description: string | null;
  status: "offen" | "erledigt";
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Todo {
  id: string;
  title: string;
  description: string | null;
  status: "offen" | "erledigt";
  priority: JobPriority;
  due_date: string | null;
  assigned_to: string | null;
  created_by: string | null;
  completed_at: string | null;
  /** Soft-Delete (Migration 172). Wenn gesetzt: Todo ist im Archiv mit
   *  'Geloescht'-Tag sichtbar, aus aktiver Liste raus. */
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  assignee?: Profile;
  job?: Job;
}

export type VertriebStatus = "offen" | "kontaktiert" | "gespraech" | "gewonnen" | "abgesagt" | "verworfen";
export type VertriebPriority = "top" | "gut" | "mittel";
export type VertriebKategorie = "verwaltung" | "veranstaltung";

export interface VertriebContact {
  id: string;
  nr: number;
  firma: string;
  branche: string | null;
  ansprechperson: string | null;
  position: string | null;
  email: string | null;
  telefon: string | null;
  event_typ: string | null;
  status: VertriebStatus;
  datum_kontakt: string | null;
  notizen: string | null;
  prioritaet: VertriebPriority;
  kategorie: VertriebKategorie;
  step: number;
  verloren_grund: string | null;
  /** Profil-ID des zustaendigen Sales-Mitarbeiters (Leo oder Mischa).
   *  Null wenn noch nicht zugewiesen. */
  assigned_to: string | null;
  /** Wiedervorlage-Konzept (Migration 169):
   *  wiedervorlage_am = wann den Lead wieder anfassen.
   *  wiedervorlage_note = warum (optional, kurz).
   *  wiedervorlage_snoozed = true wenn Lead bis dahin aus aktiver Liste
   *    ausgeblendet werden soll. Bei Faelligkeit setzt der Cron snoozed
   *    auto auf false und feuert die Benachrichtigung. */
  wiedervorlage_am: string | null;
  wiedervorlage_note: string | null;
  wiedervorlage_snoozed: boolean;
  created_at: string;
  updated_at: string;
}

export interface Room {
  id: string;
  name: string;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
  capacity: number | null;
  technical_details: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoomContact {
  id: string;
  room_id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
}

export interface RoomPrice {
  id: string;
  room_id: string;
  label: string;
  amount: number;
  currency: string;
  notes: string | null;
  created_at: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  type: "bestätigung" | "absage" | "info";
  created_at: string;
  updated_at: string;
}

export interface EmailLog {
  id: string;
  rental_request_id: string | null;
  recipient: string;
  subject: string;
  body: string;
  sent_at: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  all_day: boolean;
  job_id: string | null;
  location_id: string | null;
  profile_id: string | null;
  color: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Tickets — IT-Probleme, Belege, Stempel-Aenderungen, Material-Anfragen.
// Eine zentrale Tabelle mit type-Diskriminator + data-jsonb.
// ============================================================

export type TicketType = "it" | "beleg" | "stempel_aenderung" | "material";
export type TicketStatus = "offen" | "erledigt" | "abgelehnt";
export type TicketPriority = "niedrig" | "normal" | "hoch" | "dringend";

// Typ-spezifische data-jsonb Inhalte. Discriminierung ueber Ticket["type"].
export interface TicketDataIT {
  device?: string;
}

export interface TicketDataBeleg {
  betrag_chf: number;
  kaufdatum: string;       // YYYY-MM-DD
  lieferant?: string;
  auftrag_id?: string;
  // Genehmigung — entweder eine Person die's verbal/per Mail freigegeben hat
  // (genehmigt_von_user_id) ODER ein vorheriges, bereits erledigtes Material-
  // Ticket (genehmigt_via_ticket_id). Eines von beiden muss gesetzt sein.
  genehmigt_von_user_id?: string;
  genehmigt_via_ticket_id?: string;
}

export interface TicketDataStempelAenderung {
  // Modus 1: Korrektur eines existierenden Stempels.
  time_entry_id?: string;
  // Modus 2: Vergessen einzustempeln — neuer Eintrag.
  // Beide Modi nutzen neu_start + neu_end als Ziel-Werte.
  neu_start?: string;      // ISO timestamptz
  neu_end?: string;        // ISO timestamptz
  job_id?: string;         // optional bei Modus 2
  beschreibung?: string;
  grund: string;           // Pflicht: warum die Aenderung
}

export interface TicketDataMaterialItem {
  artikel: string;
  menge: number;
  betrag_chf?: number;
}

export interface TicketDataMaterial {
  // Pro Material-Anfrage koennen mehrere Positionen drin sein (z.B. wenn
  // ein Warenkorb-Screenshot mehrere Items enthaelt). Mindestens 1 Item
  // ist Pflicht.
  items: TicketDataMaterialItem[];
  auftrag_id?: string;
}

export type TicketData =
  | TicketDataIT
  | TicketDataBeleg
  | TicketDataStempelAenderung
  | TicketDataMaterial
  | Record<string, unknown>;

export interface Ticket {
  id: string;
  ticket_number: number;
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;
  title: string;
  description: string | null;
  data: TicketData;
  created_by: string;
  assigned_to: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  archived_at: string | null;
  // Beleg-Ablage — gefuellt wenn die Buchhaltung den Beleg abgelegt hat
  // (Bexio, Ordner, etc.). filed_reference ist die externe Referenz.
  // /abrechnung filtert auf type='beleg' AND filed_at IS NULL.
  filed_at: string | null;
  filed_reference: string | null;
  filed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketAttachment {
  id: string;
  ticket_id: string;
  storage_path: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  uploaded_at: string;
}

// Mit eingebettetem Profile fuer Listen-Views (Supabase-Join).
export type TicketWithRelations = Ticket & {
  creator: { full_name: string } | null;
  assignee: { full_name: string } | null;
  resolver: { full_name: string } | null;
  attachments: { id: string; filename: string; storage_path: string; mime_type: string | null }[];
};

// ============================================================
// Notifications — in-app Benachrichtigungen, gerendert in der Glocke
// oben in der Sidebar.
// ============================================================

// Notification-Types — semantische Kategorien. Jede Type ist ueber
// notification-meta.ts auf Icon + Akzent-Farbe gemappt damit man im
// Bell-Dropdown sofort erkennt um was es geht.
export type NotificationType =
  | "ticket_new"
  | "ticket_done"
  | "ticket_rejected"
  | "job_assigned"
  | "appointment_new"
  | "todo_assigned"
  | "todo_overdue"
  | "stempel_reminder"
  | "vertrieb_wiedervorlage"
  | "system";

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string | null;
  link: string | null;
  resource_type: string | null;
  resource_id: string | null;
  is_read: boolean;
  created_at: string;
  /** Bundle-Counter: 1 = einzeln, >1 = mehrere zusammengefasst */
  bundle_count?: number;
  /** Wenn gesetzt + in der Zukunft: Notif ist 'snoozed' und wird im
   *  UI ausgeblendet bis der Wake-Cron sie wieder aktiviert. */
  snoozed_until?: string | null;
}
