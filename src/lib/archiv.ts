/**
 * Archiv = nur lesen (Leo 2026-10-15: «alle sachen in archiven sollten nicht
 * mehr bearbeitbar sein»).
 *
 * EIN Helfer pro Bereich entscheidet, ob ein Datensatz im Archiv liegt. Die
 * Oberflaeche zeigt archivierte Datensaetze vollstaendig lesbar, aber ohne
 * Bearbeiten/Hinzufuegen/Loeschen, dazu oben <ArchivHinweis>. Der bestehende
 * Rueckweg (Reaktivieren / Wieder aktivieren) bleibt fuer Berechtigte.
 *
 * Gegenstueck in der Datenbank: Migration 342 (BEFORE-Trigger auf den
 * Haupttabellen und den wichtigsten Kind-Tabellen). Sie lehnt Schreibversuche
 * von Endnutzern (Rollen authenticated/anon, also jeder direkte Client-Write,
 * auch vom Handy) mit SQLSTATE PT409 ab — PostgREST antwortet darauf mit
 * HTTP 409, die Meldung ist die gleiche wie hier. Server-Wege (Admin-Client:
 * Rechnung/Bexio, Rapport-PDF, Crons, Mail-Eingang) laufen weiter; API-Routen,
 * die Inhalte archivierter Datensaetze aendern wuerden, antworten selbst 409.
 *
 * Bewusst ohne Server-Importe — wird in Client-Komponenten und Routen genutzt.
 */

import { JOB_STATUS_GESCHLOSSEN } from "@/lib/constants";
import { PROJECT_ARCHIVE_STATUSES } from "@/lib/projekte-format";
import { formatDateFull } from "@/lib/format";

/** SQLSTATE der DB-Sperre (Migration 342) — PostgREST macht daraus HTTP 409. */
export const ARCHIV_SQLSTATE = "PT409";

/** Fehler der DB-Sperre erkennen (supabase-js: error.code). */
export function istArchivSperre(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === ARCHIV_SQLSTATE;
}

/** Titel des Hinweises oben auf jeder archivierten Detailseite. */
export const ARCHIV_TITEL = "Archiviert – nur lesen";

// ─── Auftraege ───────────────────────────────────────────────────────────
// Archiv = abgeschlossen oder storniert (Archiv-Segment auf /auftraege).

export function auftragArchiviert(status: string | null | undefined): boolean {
  return (JOB_STATUS_GESCHLOSSEN as readonly string[]).includes(status ?? "");
}

export const AUFTRAG_ARCHIV_MELDUNG =
  "Der Auftrag ist archiviert (abgeschlossen oder storniert) und kann nur noch gelesen werden.";

// ─── Kunden ──────────────────────────────────────────────────────────────
// Archiv = archived_at gesetzt (Kunden-Archiv). Rueckweg: «Reaktivieren».

export function kundeArchiviert(kunde: { archived_at?: string | null } | null | undefined): boolean {
  return !!kunde?.archived_at;
}

export const KUNDE_ARCHIV_MELDUNG =
  "Der Kunde ist archiviert und kann nur noch gelesen werden — zum Bearbeiten zuerst reaktivieren.";

// ─── Locations (Standorte) ───────────────────────────────────────────────
// Archiv = archived_at gesetzt (Locations-Archiv). Rueckweg: «Reaktivieren».

export function standortArchiviert(location: { archived_at?: string | null } | null | undefined): boolean {
  return !!location?.archived_at;
}

export const STANDORT_ARCHIV_MELDUNG =
  "Die Location ist archiviert und kann nur noch gelesen werden — zum Bearbeiten zuerst reaktivieren.";

// ─── Projekte ────────────────────────────────────────────────────────────
// Archiv = abgeschlossen, abgelehnt oder storniert (PROJECT_ARCHIVE_STATUSES).

export function projektArchiviert(status: string | null | undefined): boolean {
  return PROJECT_ARCHIVE_STATUSES.includes(status ?? "");
}

export const PROJEKT_ARCHIV_MELDUNG =
  "Das Projekt ist archiviert (abgeschlossen, abgelehnt oder storniert) und kann nur noch gelesen werden.";

// ─── Entwuerfe (Auftrags-Entwuerfe) ──────────────────────────────────────
// Archiv = storniert oder umgewandelt. Rueckweg nur fuer stornierte:
// «Wieder aktivieren».

export const ENTWURF_ARCHIV_STATUS = ["storniert", "umgewandelt"] as const;

export function entwurfArchiviert(status: string | null | undefined): boolean {
  return (ENTWURF_ARCHIV_STATUS as readonly string[]).includes(status ?? "");
}

export const ENTWURF_ARCHIV_MELDUNG =
  "Der Entwurf ist archiviert (storniert oder umgewandelt) und kann nur noch gelesen werden.";

// ─── Vermerk «Storniert am … von … — Begruendung: …» ──────────────────────

/** «Storniert am 14.10.2026 von Leo Muster» — fehlende Teile fallen weg. */
export function vermerk(art: string, am?: string | null, von?: string | null): string {
  let s = art;
  if (am) s += ` am ${formatDateFull(am)}`;
  if (von?.trim()) s += ` von ${von.trim()}`;
  return s;
}

/** Vermerk plus « — Begründung: …» (fuer Tooltips in Listen). */
export function vermerkMitBegruendung(
  art: string,
  am?: string | null,
  von?: string | null,
  begruendung?: string | null,
): string {
  const v = vermerk(art, am, von);
  const grund = begruendung?.trim();
  return grund ? `${v} — Begründung: ${grund}` : v;
}

/** Storno-Angaben eines Auftrags (jobs.cancelled_*). Der Name kommt aus dem
 *  Profil-Join; ist das Profil geloescht, aus der Namens-Historie
 *  (jobs.cancelled_by_name, Migration 222). */
export type AuftragStorno = {
  status?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  cancelled_by_name?: string | null;
  cancelled_by_profile?: { full_name?: string | null } | null;
};

export function auftragStornoVon(job: AuftragStorno): string | null {
  return job.cancelled_by_profile?.full_name ?? job.cancelled_by_name ?? null;
}

/** Tooltip am «Storniert»-Badge in Listen — nur intern verwenden (der Grund
 *  ist eine interne Notiz und gehoert nicht ins Partner-/Lieferantenportal). */
export function auftragStornoTooltip(job: AuftragStorno): string | undefined {
  if (job.status !== "storniert") return undefined;
  return vermerkMitBegruendung("Storniert", job.cancelled_at, auftragStornoVon(job), job.cancellation_reason);
}
