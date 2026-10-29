/** Ein Anhang am Raum — gleiches Format wie rooms._docs. */
export interface VertriebDokument {
  name: string;
  /** Pfad im privaten Bucket `documents`, immer unter `vertrieb/<raum-id>/`. */
  path: string;
  uploaded_at: string;
}

/** Ein Veranstaltungsraum, den wir anschreiben wollen (Tabelle vertrieb_raeume). */
export interface VertriebRaum {
  id: string;
  name: string;
  ort: string | null;
  ansprechperson: string | null;
  email: string | null;
  telefon: string | null;
  website: string | null;
  infos: string | null;
  erstmail: string | null;
  /** Date-Only (YYYY-MM-DD): naechster Schritt, erscheint im Kalender. */
  datum: string | null;
  aufgabe: string | null;
  dokumente: VertriebDokument[];
  created_at: string;
  updated_at: string;
}

/** Status eines Kampagnen-Kontakts (Check-Constraint in Migration 365). */
export type KampagneStatus =
  | "offen" | "geplant" | "gesendet" | "geantwortet" | "termin"
  | "offerte" | "auftrag" | "kein_bedarf" | "unzustellbar" | "anrufen";

/** Eine Akquise-Kampagne (Tabelle vertrieb_kampagnen), z. B. «Messe 2027». */
export interface VertriebKampagne {
  id: string;
  name: string;
  beschreibung: string | null;
  /** Bezeichnung der Gruppierung, z. B. «Messe» oder «Welle». */
  gruppe_label: string | null;
  sortierung: number;
  aktiv: boolean;
}

/** Ein Kontakt einer Kampagne (Tabelle vertrieb_kampagne_kontakte). */
export interface KampagneKontakt {
  id: string;
  kampagne_id: string;
  nr: string;
  firma: string;
  gruppe: string | null;
  prioritaet: string | null;
  ansprechperson: string | null;
  funktion: string | null;
  email: string | null;
  telefon: string | null;
  website: string | null;
  ort: string | null;
  region: string | null;
  hinweis: string | null;
  notizen: string | null;
  status: KampagneStatus;
  mail_betreff: string | null;
  mail_text: string | null;
  mail_sprache: string | null;
  mail_anhang: string | null;
  mail_an: string | null;
  mail_geplant_am: string | null;
  mail_gesendet_am: string | null;
  letzte_antwort_am: string | null;
  letzte_antwort_betreff: string | null;
  antworten_anzahl: number;
  /** Microsoft-Konversation der Erstmail (vom Abgleich). */
  mail_conversation_id: string | null;
  /** Graph-IDs der vom Abgleich zugeordneten Antworten (nur Server schreibt). */
  antwort_graph_ids: string[];
  status_manuell: boolean;
  /** Vorbereitete Nachfass-Mail (KI-Vorschlag, editierbar). */
  nachfass_betreff: string | null;
  nachfass_text: string | null;
  nachgefasst_am: string | null;
  nachfass_anzahl: number;
  updated_at: string;
}

/** Eine Zeile der Liste (RPC vertrieb_kampagne_liste, Migration 366). */
export type KampagneKontaktZeile = Pick<
  KampagneKontakt,
  "id" | "nr" | "firma" | "gruppe" | "ansprechperson" | "status"
  | "mail_geplant_am" | "mail_gesendet_am" | "letzte_antwort_am"
> & {
  nachfassen_faellig: boolean;
  /** Sortier-Rang: 0 Antwort · 1 Anrufen · 2 Nachfassen · 3 Termin/Offerte · 4 Rest · 5 abgeschlossen. */
  rang: number;
};

/** Eine Antwort-Mail, live aus dem Postfach (nie gespeichert). */
export interface KampagneAntwort {
  id: string;
  betreff: string;
  von: string;
  vonName: string | null;
  empfangenAm: string;
  text: string;
}

/** Sync-Stand des Postfach-Abgleichs (ohne Token), von /api/vertrieb/mail-sync. */
export interface MailSyncStand {
  verbunden: boolean;
  postfach: string | null;
  letzter_sync_am: string | null;
  letzter_sync_fehler: string | null;
}
