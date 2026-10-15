// Server-Helfer «Archiv = nur lesen» fuer API-Routen (nur in Routen
// importieren). Regeln und Meldungen: src/lib/archiv.ts. Routen, die Inhalte
// archivierter Datensaetze aendern wuerden, antworten 409 — dieselbe Meldung
// wie die DB-Sperre (Migration 342, SQLSTATE PT409 → HTTP 409).
//
// Bewusst NICHT gesperrt (System-Nachlaeufe nach dem Archivieren): Rechnung/
// Bexio (invoiced_*, invoice_skipped_*), Rapport-PDF + Auto-Stempel nach dem
// Abschluss, Mail-Eingang (auftrag@in…), Namens-Historie.

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  auftragArchiviert,
  kundeArchiviert,
  standortArchiviert,
  projektArchiviert,
  entwurfArchiviert,
  istArchivSperre,
  AUFTRAG_ARCHIV_MELDUNG,
  KUNDE_ARCHIV_MELDUNG,
  STANDORT_ARCHIV_MELDUNG,
  PROJEKT_ARCHIV_MELDUNG,
  ENTWURF_ARCHIV_MELDUNG,
} from "@/lib/archiv";

/** 409 im ueblichen Routen-Format ({ success:false, error }) plus code. */
export function archivAntwort(meldung: string): NextResponse {
  return NextResponse.json({ success: false, code: "archiviert", error: meldung }, { status: 409 });
}

/** DB-Sperre (PT409) aus einem Supabase-Fehler als 409 weiterreichen. */
export function archivAntwortAusFehler(error: { code?: string | null; message?: string | null } | null | undefined): NextResponse | null {
  if (!istArchivSperre(error)) return null;
  return archivAntwort(error?.message || "Der Datensatz ist archiviert und kann nur noch gelesen werden.");
}

const pruefFehler = () =>
  NextResponse.json({ success: false, error: "Archiv-Status konnte nicht geprüft werden" }, { status: 500 });

/** Auftrag archiviert (abgeschlossen/storniert) → 409, sonst null.
 *  Nicht gefunden → null (die Route meldet selbst 404). */
export async function auftragArchivSperre(admin: SupabaseClient, jobId: string): Promise<NextResponse | null> {
  const { data, error } = await admin.from("jobs").select("status").eq("id", jobId).maybeSingle();
  if (error) return pruefFehler();
  return data && auftragArchiviert(data.status as string) ? archivAntwort(AUFTRAG_ARCHIV_MELDUNG) : null;
}

/** Kunde archiviert → 409, sonst null. */
export async function kundeArchivSperre(admin: SupabaseClient, customerId: string): Promise<NextResponse | null> {
  const { data, error } = await admin.from("customers").select("archived_at").eq("id", customerId).maybeSingle();
  if (error) return pruefFehler();
  return data && kundeArchiviert(data as { archived_at: string | null }) ? archivAntwort(KUNDE_ARCHIV_MELDUNG) : null;
}

/** Location archiviert → 409, sonst null. */
export async function standortArchivSperre(admin: SupabaseClient, locationId: string): Promise<NextResponse | null> {
  const { data, error } = await admin.from("locations").select("archived_at").eq("id", locationId).maybeSingle();
  if (error) return pruefFehler();
  return data && standortArchiviert(data as { archived_at: string | null }) ? archivAntwort(STANDORT_ARCHIV_MELDUNG) : null;
}

/** Projekt archiviert (abgeschlossen/abgelehnt/storniert) → 409, sonst null. */
export async function projektArchivSperre(admin: SupabaseClient, projectId: string): Promise<NextResponse | null> {
  const { data, error } = await admin.from("projects").select("status").eq("id", projectId).maybeSingle();
  if (error) return pruefFehler();
  return data && projektArchiviert(data.status as string) ? archivAntwort(PROJEKT_ARCHIV_MELDUNG) : null;
}

/** Entwurf archiviert (storniert/umgewandelt) → 409, sonst null. */
export async function entwurfArchivSperre(admin: SupabaseClient, draftId: string): Promise<NextResponse | null> {
  const { data, error } = await admin.from("job_drafts").select("status").eq("id", draftId).maybeSingle();
  if (error) return pruefFehler();
  return data && entwurfArchiviert(data.status as string) ? archivAntwort(ENTWURF_ARCHIV_MELDUNG) : null;
}

const UPLOAD_ZIEL = /^(jobs|projekte|standorte)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

/** /api/upload: keine neuen Dateien an archivierten Auftraegen, Projekten
 *  oder Locations — die DB lehnt die documents-Zeile ohnehin ab (Migration
 *  342), die Datei bliebe sonst verwaist im Storage liegen. */
export async function uploadArchivSperre(admin: SupabaseClient, path: string): Promise<NextResponse | null> {
  const m = UPLOAD_ZIEL.exec(path);
  if (!m) return null;
  const id = m[2].toLowerCase();
  if (m[1] === "jobs") return auftragArchivSperre(admin, id);
  if (m[1] === "projekte") return projektArchivSperre(admin, id);
  return standortArchivSperre(admin, id);
}
