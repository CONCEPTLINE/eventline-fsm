/**
 * Extrahiert aus den FormValues drei Buckets:
 *  - core: Felder die direkt in Job-Spalten geschrieben werden (via mapTo)
 *  - answers: Felder die in jobs.form_answers (jsonb) gespeichert werden
 *  - files: Datei-Anhaenge (alle file-upload Blocks zusammen)
 *  - primaryAppointment: Konvention — Blocks mit ID 'termin_date' (date)
 *    und 'termin_time_range' (timerange) bilden den Haupt-Termin der
 *    Anfrage. Wenn beide gefuellt → wird als job_appointments-Datensatz
 *    angelegt. Diese IDs sind "reserved" — Admin soll sie im Builder
 *    nicht umbenennen.
 */

import type { FormSchema, FormBlock, DateRangeBlock } from "./types";
import { isInputBlock } from "./types";
import type { FormValues } from "@/components/partner-form/form-renderer";

export interface ExtractedForm {
  core: Record<string, string>;
  answers: Record<string, unknown>;
  files: File[];
  primaryAppointment: {
    date?: string;
    start_time?: string;
    end_time?: string;
  };
}

export function extractFormValues(schema: FormSchema, values: FormValues): ExtractedForm {
  const core: Record<string, string> = {};
  const answers: Record<string, unknown> = {};
  const files: File[] = [];
  const primaryAppointment: ExtractedForm["primaryAppointment"] = {};

  for (const b of schema.blocks) {
    const v = values[b.id];

    if (b.type === "daterange") {
      const dr = b as DateRangeBlock;
      const dv = (v as { start?: string; end?: string }) ?? {};
      if (dr.mapToStart && dv.start) core[dr.mapToStart] = dv.start;
      if (dr.mapToEnd && dv.end) core[dr.mapToEnd] = dv.end;
      continue;
    }

    if (b.type === "file-upload") {
      const fs = (v as File[]) ?? [];
      files.push(...fs);
      continue;
    }

    // Konvention: termin_date + termin_time_range = Primary Appointment.
    if (b.id === "termin_date" && b.type === "date") {
      if (typeof v === "string" && v) primaryAppointment.date = v;
      // termin_date NICHT auch noch in answers/core schreiben.
      continue;
    }
    if (b.id === "termin_time_range" && b.type === "timerange") {
      const tv = (v as { start?: string; end?: string }) ?? {};
      if (tv.start) primaryAppointment.start_time = tv.start;
      if (tv.end) primaryAppointment.end_time = tv.end;
      continue;
    }

    if (!isInputBlock(b)) continue;

    // Generic Input-Block: mapTo → core, sonst → answers.
    const isEmpty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
    if (isEmpty) continue;

    const mapTo = getMapTo(b);
    if (mapTo) {
      core[mapTo] = typeof v === "string" ? v : String(v);
    } else {
      answers[b.id] = v;
    }
  }

  return { core, answers, files, primaryAppointment };
}

function getMapTo(b: FormBlock): string | undefined {
  if ("mapTo" in b && typeof b.mapTo === "string") return b.mapTo;
  return undefined;
}
