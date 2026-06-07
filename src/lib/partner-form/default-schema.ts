/**
 * Default-Schema = die hardcoded Partner-Anfrage-Form von vor der
 * Refactoring-Aktion, jetzt als Schema-Blocks. Wird ins partner_form_template
 * geseedet wenn noch keins existiert. Admin kann's anschliessend frei
 * editieren.
 *
 * Wenn du das Schema veraenderst, mach NICHT direkt das DB-Live-Schema
 * kaputt — diese Datei wird nur als Seed verwendet wenn die DB komplett
 * leer ist. Existierende Templates bleiben unveraendert.
 */

import type { FormSchema } from "./types";

export const DEFAULT_PARTNER_FORM_SCHEMA: FormSchema = {
  version: 1,
  submit: {
    draft_label: "Als Entwurf speichern",
    send_label: "Anfrage senden",
  },
  blocks: [
    {
      id: "title",
      type: "text",
      label: "Titel",
      placeholder: "z.B. Hochzeit Müller / Konzert XYZ",
      required: true,
      mapTo: "title",
    },
    {
      id: "section_event",
      type: "section-header",
      title: "Veranstaltung",
      description: "Wann findet die Veranstaltung statt?",
    },
    {
      id: "event_range",
      type: "daterange",
      start_label: "Startdatum",
      end_label: "Enddatum",
      required_start: true,
      mapToStart: "start_date",
      mapToEnd: "end_date",
      hint_end: "Leer = gleicher Tag wie Start",
    },
    {
      id: "section_termin",
      type: "section-header",
      title: "Termin",
      description: "Der konkrete Anlass innerhalb der Veranstaltung. Ohne Termin → Entwurf-Modus.",
    },
    {
      id: "termin_date",
      type: "date",
      label: "Datum",
      hint: "Ohne Termin → als Entwurf speichern. Mit Termin direkt absenden.",
    },
    {
      id: "termin_time_range",
      type: "timerange",
      start_label: "Von",
      end_label: "Bis",
      step: 30,
    },
    {
      id: "description",
      type: "textarea",
      label: "Beschreibung",
      placeholder: "Was ist geplant? Art der Veranstaltung, Besonderheiten, Anzahl Gäste…",
      rows: 4,
      mapTo: "description",
    },
    {
      id: "section_contact",
      type: "section-header",
      title: "Veranstalter-Kontakt",
      description: "Damit EVENTLINE direkt mit dem Endkunden sprechen kann.",
    },
    {
      id: "contact_person",
      type: "text",
      label: "Ansprechperson",
      placeholder: "Vor- und Nachname",
      required: true,
      mapTo: "contact_person",
    },
    {
      id: "contact_phone",
      type: "phone",
      label: "Telefon",
      placeholder: "0041 55 556 62 61",
      required: true,
      mapTo: "contact_phone",
    },
    {
      id: "contact_email",
      type: "email",
      label: "E-Mail",
      placeholder: "optional",
      mapTo: "contact_email",
    },
    {
      id: "attachments",
      type: "file-upload",
      label: "Anhänge",
      accept: ".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg",
      multiple: true,
      hint: "Optional — z.B. Anfrage-PDF, Skizzen, Bilder.",
    },
  ],
};
