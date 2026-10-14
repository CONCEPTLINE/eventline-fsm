// Update-Payload der Seite «Auftrag bearbeiten» — NUR die Felder, die der
// Nutzer im Formular wirklich geändert hat (Review 2026-10-14).
//
// Vorher schrieb jedes Speichern alle 14 Stammdaten-Felder neu: Felder, die
// das Formular gar nicht zeigt, wurden geleert (z.B. location_id und
// Veranstalter-Kontakt bei einem aus einem Entwurf umgewandelten
// «Firma/Privat»-Auftrag → Partner verlor den Zugriff; room_id bei
// Location-Aufträgen), Daten rutschten auf Mitternacht Zürich und Texte
// wurden getrimmt — mit falschen Einträgen im Änderungsverlauf (Migration 319).
//
// Regel: Kein Feld ändert seinen Wert ohne Nutzeraktion. Felder der jeweils
// anderen Auftragsart werden nur geleert, wenn die Auftragsart tatsächlich
// gewechselt wurde (dann wie bisher: Location ↔ Firma/Privat).

import type { AuftragFormState } from "@/components/auftrag-form-fields";
import { toDbDate } from "@/lib/format";

export type JobStammdatenUpdate = Partial<{
  job_type: AuftragFormState["job_type"];
  title: string;
  description: string | null;
  priority: "dringend" | "normal";
  customer_id: string | null;
  location_id: string | null;
  room_id: string | null;
  external_address: string | null;
  start_date: string | null;
  end_date: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  project_lead_id: string | null;
}>;

/**
 * @param form   aktueller Formular-Stand
 * @param geladen Formular-Stand, wie er aus der DB geladen wurde (gleiche
 *                Normalisierung: Daten als YYYY-MM-DD in Zürich, Texte roh)
 */
export function bearbeitenPayload(form: AuftragFormState, geladen: AuftragFormState): JobStammdatenUpdate {
  const p: JobStammdatenUpdate = {};
  const geaendert = (k: keyof AuftragFormState) => form[k] !== geladen[k];
  const text = (v: string) => v.trim() || null;
  const artGewechselt = form.job_type !== geladen.job_type;

  if (artGewechselt) p.job_type = form.job_type;
  if (geaendert("title")) p.title = form.title.trim();
  if (geaendert("description")) p.description = text(form.description);
  if (geaendert("urgent")) p.priority = form.urgent ? "dringend" : "normal";
  if (geaendert("project_lead_id")) p.project_lead_id = form.project_lead_id || null;
  if (geaendert("start_date")) p.start_date = toDbDate(form.start_date);
  if (geaendert("end_date")) p.end_date = toDbDate(form.end_date);

  if (form.job_type === "location") {
    if (artGewechselt) {
      // Firma/Privat → Location: Felder der alten Art leeren, die der neuen
      // Art so speichern, wie das Formular sie jetzt zeigt.
      p.customer_id = null;
      p.room_id = null;
      p.external_address = null;
      p.location_id = form.location_id || null;
      p.contact_person = text(form.contact_person);
      p.contact_phone = text(form.contact_phone);
      p.contact_email = text(form.contact_email);
    } else {
      if (geaendert("location_id")) p.location_id = form.location_id || null;
      if (geaendert("contact_person")) p.contact_person = text(form.contact_person);
      if (geaendert("contact_phone")) p.contact_phone = text(form.contact_phone);
      if (geaendert("contact_email")) p.contact_email = text(form.contact_email);
    }
  } else if (artGewechselt) {
    // Location → Firma/Privat: Location und Veranstalter-Kontakt gehören
    // nicht zur Firma/Privat-Art (dort ist der Kunde der Kontakt).
    p.location_id = null;
    p.contact_person = null;
    p.contact_phone = null;
    p.contact_email = null;
    p.customer_id = form.customer_id || null;
    p.external_address = text(form.external_address);
    p.room_id = form.room_id || null;
  } else {
    if (geaendert("customer_id")) p.customer_id = form.customer_id || null;
    if (geaendert("external_address")) p.external_address = text(form.external_address);
    if (geaendert("room_id")) p.room_id = form.room_id || null;
  }

  return p;
}
