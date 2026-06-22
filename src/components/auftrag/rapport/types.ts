// Geteilte Types fuer das Rapport-Modal und seine Sub-Komponenten.
// Liegen hier in einem eigenen File damit die Sub-Komponenten und der
// Orchestrator (rapport-form-modal.tsx) auf das gleiche Schema zugreifen.

export interface TimeRange {
  date: string;
  start: string;
  end: string;
  pause: number;
  /** Pro Einsatztag ein Techniker — auf einem Auftrag arbeiten oft mehrere
   *  Personen an verschiedenen Tagen. ID aus profiles. */
  technician_id: string;
  /** Optional: diese Stunden werden NICHT dem Kunden verrechnet (z.B.
   *  Kulanz, Eigenleistung, Fehler-Korrektur). Bei true ist
   *  not_billable_reason Pflicht und wird im PDF + in der Abrechnung
   *  separat ausgewiesen. */
  not_billable?: boolean;
  not_billable_reason?: string;
}

export interface ProfileOption {
  id: string;
  full_name: string;
}

// Foto wird beim Auswaehlen sofort hochgeladen — der lokale "PhotoFile"
// existiert nur kurzzeitig waehrend des Uploads. Nach Upload kommt's als
// UploadedPhoto zurueck (mit storage_path + report_photos.id).
export interface UploadedPhoto {
  id: string;
  storage_path: string;
  preview_url: string;
  caption: string;
  sort_order: number;
}

export interface RapportForm {
  work_description: string;
  equipment_used: string;
  issues: string;
  client_name: string;
  technician_id: string;
  technician_name: string;
}
