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
