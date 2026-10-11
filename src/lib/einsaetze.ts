// «Meine Einsätze» — EINE Abfrage fuer alle Handy-Screens, die eigene Termine
// zeigen (Dashboard «Heute», Kalender-Tagesliste, Stempel-Sheet «Heute
// zugeteilt»). Client-seitig ueber den normalen Supabase-Client: RLS liefert
// nur Sichtbares, der Filter `assigned_to = meId` macht daraus «meine».
//
// meId IMMER aus usePermissions().meId — nie aus auth.getUser(): der liefert
// bei «Ansicht als» den echten Admin statt des angesehenen Users.
//
// Zeitgrenzen in Europe/Zurich (Zeitumstellung 25.10.2026: Tage werden ueber
// Kalenderdaten weitergezaehlt, nie mit +24 h).
//
// Offline: ladeMeineEinsaetzeGecacht legt jedes Online-Ergebnis im IndexedDB-
// Cache ab (src/lib/offline/db.ts, je Nutzer + von/bis-Bereich) und liefert
// ohne Netz den letzten Stand zurueck — Heute-Screen, Kalender-Tagesliste und
// Stempel-Sheet teilen sich so EINEN Cache.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ZRH_TZ, localDateIso, todayLocalIso, plusTage } from "@/lib/swiss-time";
import { JOB_STATUS_VORSTUFEN } from "@/lib/constants";
import { formatDate, formatTime } from "@/lib/format";
import { cacheLesen, cacheSchreiben } from "@/lib/offline/db";
import { istNetzfehler } from "@/lib/offline/stempel-outbox";

export type RapportStatus = "keiner" | "entwurf" | "abgeschlossen";

export interface EinsatzJob {
  id: string;
  job_number: number | null;
  title: string;
  status: string;
  /** Enddatum des Auftrags (jobs.end_date) — erst ab diesem Tag ist der
   *  Rapport faellig (gleiche Regel wie finalize). Fehlt in alten
   *  Cache-Eintraegen (undefined) → keine Sperre wie bisher. */
  end_date: string | null;
  location_id: string | null;
  /** Location- bzw. Raumname. */
  ort: string | null;
  /** Externe Adresse, wenn keine Location/kein Raum hinterlegt ist. */
  adresse: string | null;
  kunde: string | null;
  rapport: RapportStatus;
}

export interface EinsatzProjekt {
  id: string;
  project_number: number | null;
  title: string;
}

export interface Einsatz {
  id: string;
  art: "auftrag" | "projekt" | "termin";
  /** ISO timestamptz */
  start: string;
  ende: string | null;
  zeit_modus: "fix" | "verschiebbar" | "deadline" | null;
  /** Termin-Titel (bei Auftraegen oft gleich dem Auftragstitel). */
  titel: string;
  meeting_link: string | null;
  job: EinsatzJob | null;
  projekt: EinsatzProjekt | null;
}

// ---------------------------------------------------------------------------
// Zeit (Europe/Zurich)
// ---------------------------------------------------------------------------

function zurichOffsetMinuten(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZRH_TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const alsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((alsUtc - d.getTime()) / 60000);
}

/** Mitternacht Zuerich des Kalendertags YYYY-MM-DD als UTC-ISO. Zwei Durch-
 *  gaenge, damit der Offset vom Zeitpunkt der Mitternacht selbst stammt
 *  (DST-Wechseltage). */
export function zuerichMitternachtIso(tag: string): string {
  const [y, m, d] = tag.split("-").map(Number);
  const utcMitternacht = Date.UTC(y, m - 1, d);
  let ms = utcMitternacht - zurichOffsetMinuten(new Date(utcMitternacht)) * 60000;
  ms = utcMitternacht - zurichOffsetMinuten(new Date(ms)) * 60000;
  return new Date(ms).toISOString();
}

/** Kalendertag (Zuerich) eines Zeitpunkts als YYYY-MM-DD. */
export function zuerichTag(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZRH_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function heuteTag(): string {
  return todayLocalIso();
}

export { plusTage };

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

type JobRow = {
  id: string; job_number: number | null; title: string; status: string; end_date: string | null; is_deleted: boolean | null;
  location_id: string | null; external_address: string | null;
  location: { name: string } | { name: string }[] | null;
  room: { name: string } | { name: string }[] | null;
  customer: { name: string } | { name: string }[] | null;
  service_reports: { status: string }[] | null;
};
type AuftragTerminRow = {
  id: string; title: string; start_time: string; end_time: string | null;
  zeit_modus: "fix" | "verschiebbar" | "deadline" | null; meeting_link: string | null;
  job_id: string | null; job: JobRow | JobRow[] | null;
};
type ProjektTerminRow = {
  id: string; title: string; start_time: string; end_time: string | null;
  project: { id: string; project_number: number | null; title: string } | { id: string; project_number: number | null; title: string }[] | null;
};

function eins<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function rapportStatus(reports: { status: string }[] | null | undefined): RapportStatus {
  if (!reports || reports.length === 0) return "keiner";
  if (reports.some((r) => r.status === "abgeschlossen")) return "abgeschlossen";
  return "entwurf";
}

/** Fensterbedingung: Termin ueberschneidet [von, bis). Deadline-Termine
 *  (ohne Ende) zaehlen am Tag ihres Starts. */
function fenster(vonIso: string, bisIso: string) {
  return `end_time.gte.${vonIso},and(end_time.is.null,start_time.gte.${vonIso})`;
}

/**
 * Eigene Einsaetze zwischen zwei Kalendertagen (Zuerich), `bisTag` exklusiv.
 * Beispiel heute: ladeMeineEinsaetze(sb, meId, heuteTag(), plusTage(heuteTag(), 1)).
 * Laufende Termine (Start vorbei, Ende noch nicht) sind enthalten. Termine
 * stornierter oder geloeschter Auftraege werden verworfen.
 */
export async function ladeMeineEinsaetze(
  supabase: SupabaseClient,
  meId: string,
  vonTag: string,
  bisTag: string,
): Promise<Einsatz[]> {
  const vonIso = zuerichMitternachtIso(vonTag);
  const bisIso = zuerichMitternachtIso(bisTag);
  const [auftraegeRes, projekteRes] = await Promise.all([
    supabase
      .from("job_appointments")
      .select(
        "id, title, start_time, end_time, zeit_modus, meeting_link, job_id, " +
          "job:jobs(id, job_number, title, status, end_date, is_deleted, location_id, external_address, " +
          "location:locations(name), room:rooms(name), customer:customers(name), service_reports(status))",
      )
      .eq("assigned_to", meId)
      .lt("start_time", bisIso)
      .or(fenster(vonIso, bisIso))
      .order("start_time", { ascending: true }),
    supabase
      .from("project_appointments")
      .select("id, title, start_time, end_time, project:projects(id, project_number, title)")
      .eq("assigned_to", meId)
      .lt("start_time", bisIso)
      .or(fenster(vonIso, bisIso))
      .order("start_time", { ascending: true }),
  ]);
  if (auftraegeRes.error) throw new Error(auftraegeRes.error.message);
  if (projekteRes.error) throw new Error(projekteRes.error.message);

  const aus: Einsatz[] = [];
  for (const row of (auftraegeRes.data ?? []) as unknown as AuftragTerminRow[]) {
    const job = eins(row.job);
    if (row.job_id && !job) continue; // Auftrag nicht sichtbar (RLS) → nicht anzeigen
    if (job && (job.is_deleted === true || job.status === "storniert")) continue;
    aus.push({
      id: row.id,
      art: job ? "auftrag" : "termin",
      start: row.start_time,
      ende: row.end_time,
      zeit_modus: row.zeit_modus ?? null,
      titel: (row.title ?? "").trim() || job?.title || "Einsatz",
      meeting_link: row.meeting_link ?? null,
      job: job
        ? {
            id: job.id,
            job_number: job.job_number,
            title: job.title,
            status: job.status,
            end_date: job.end_date,
            location_id: job.location_id,
            ort: eins(job.location)?.name ?? eins(job.room)?.name ?? null,
            adresse: eins(job.location) || eins(job.room) ? null : (job.external_address?.trim() || null),
            kunde: eins(job.customer)?.name ?? null,
            rapport: rapportStatus(job.service_reports),
          }
        : null,
      projekt: null,
    });
  }
  for (const row of (projekteRes.data ?? []) as unknown as ProjektTerminRow[]) {
    const projekt = eins(row.project);
    aus.push({
      id: row.id,
      art: "projekt",
      start: row.start_time,
      ende: row.end_time,
      zeit_modus: null,
      titel: (row.title ?? "").trim() || projekt?.title || "Projekt-Termin",
      meeting_link: null,
      job: null,
      projekt: projekt ? { id: projekt.id, project_number: projekt.project_number, title: projekt.title } : null,
    });
  }
  aus.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return aus;
}

// ---------------------------------------------------------------------------
// Offline-Cache
// ---------------------------------------------------------------------------

export interface Gecacht<T> {
  daten: T;
  /** UTC-ISO des Ladezeitpunkts — beim Cache-Treffer der Stand des Eintrags. */
  standAt: string | null;
  /** true = ohne Netz aus dem letzten Online-Stand. */
  ausCache: boolean;
}

/** Fehler, der «kein Netz» bedeutet (Fetch-Abbruch, navigator.onLine false).
 *  RLS-/Server-Fehler sind keine — die duerfen nie durch alte Daten verdeckt
 *  werden. */
function istNetzAusnahme(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  return istNetzfehler({ message: e instanceof Error ? e.message : String(e) }, undefined);
}

/**
 * Online laden und das Ergebnis unter `schluessel` je Nutzer ablegen; bei
 * Netzfehler den letzten Stand aus dem Cache liefern. Ohne Cache-Eintrag
 * (oder bei anderem Fehler) wird der urspruengliche Fehler weitergeworfen.
 * Der Cache-Schreibvorgang laeuft nebenher — er ist Beschleunigung, kein Muss.
 */
export async function ladeGecacht<T>(meId: string, schluessel: string, laden: () => Promise<T>): Promise<Gecacht<T>> {
  try {
    const daten = await laden();
    void cacheSchreiben(meId, schluessel, daten).catch(() => { /* Cache ist Beschleunigung, kein Muss */ });
    return { daten, standAt: new Date().toISOString(), ausCache: false };
  } catch (e) {
    if (!istNetzAusnahme(e)) throw e;
    const eintrag = await cacheLesen<T>(meId, schluessel).catch(() => null);
    if (!eintrag) throw e;
    return { daten: eintrag.data, standAt: eintrag.stand_at, ausCache: true };
  }
}

export interface EinsaetzeGecacht extends Omit<Gecacht<Einsatz[]>, "daten"> {
  liste: Einsatz[];
}

/** Wie ladeMeineEinsaetze, aber mit Offline-Cache (Schluessel = von/bis-
 *  Bereich — ein anderer Bereich ist ein anderer Eintrag). */
export async function ladeMeineEinsaetzeGecacht(
  supabase: SupabaseClient,
  meId: string,
  vonTag: string,
  bisTag: string,
): Promise<EinsaetzeGecacht> {
  const { daten, standAt, ausCache } = await ladeGecacht(meId, `einsaetze:${vonTag}:${bisTag}`, () =>
    ladeMeineEinsaetze(supabase, meId, vonTag, bisTag),
  );
  return { liste: daten, standAt, ausCache };
}

/** «von 07:42» (heute, Zuerich) bzw. «vom Do 09.10. 17:05» — fuer die
 *  Hinweiszeile «Stand … · offline». */
export function standText(iso: string): string {
  return zuerichTag(iso) === heuteTag() ? `von ${formatTime(iso)}` : `vom ${formatDate(iso)} ${formatTime(iso)}`;
}

// ---------------------------------------------------------------------------
// Zustand eines Einsatzes
// ---------------------------------------------------------------------------

/** Auf diesen Auftrag darf gestempelt werden (offen/anfrage/entwurf — gleicher
 *  Filter wie die Auftragsliste im Stempel-Modal). */
export function istBestempelbar(job: { status: string } | null | undefined): boolean {
  return !!job && (JOB_STATUS_VORSTUFEN as readonly string[]).includes(job.status);
}

/** «Fertig bis»-Termin (Migration 268/269): start = Deadline, kein Ende. */
export function istDeadline(e: Einsatz): boolean {
  return e.zeit_modus === "deadline" && !e.ende;
}

export function istLaufend(e: Einsatz, now: number = Date.now()): boolean {
  const start = Date.parse(e.start);
  const heuteZrh = zuerichTag(new Date(now).toISOString());
  // Deadline: am Tag der Deadline bis zur Deadline laufend (die Arbeit ist
  // heute faellig), danach ueberfaellig (= vorbei) — nicht erst ab Mitternacht.
  if (istDeadline(e)) return zuerichTag(e.start) === heuteZrh && start >= now;
  if (start > now) return false;
  if (e.ende) return Date.parse(e.ende) >= now;
  // Ohne Ende (z. B. Projekt-Termin): gilt als laufend bis Ende des Starttags.
  return zuerichTag(e.start) === heuteZrh;
}

export function istVorbei(e: Einsatz, now: number = Date.now()): boolean {
  if (istDeadline(e)) return Date.parse(e.start) < now;
  if (e.ende) return Date.parse(e.ende) < now;
  return Date.parse(e.start) < now && !istLaufend(e, now);
}

/** Rapport steht aus: Auftrag offen, Einsatz vorbei, Enddatum des Auftrags
 *  erreicht, kein abgeschlossener Rapport. Das Enddatum entscheidet je
 *  AUFTRAG (nicht je Termin): Aufbau am Montag, Event am Freitag → erst ab
 *  Freitag offen — gleiche Regel wie finalize (Kalendertag Zuerich), sonst
 *  verlangt die Liste einen Abschluss, den der Server ablehnt. */
export function rapportOffen(e: Einsatz, now: number = Date.now()): boolean {
  if (!e.job) return false;
  if (e.job.status !== "offen") return false;
  if (e.job.rapport === "abgeschlossen") return false;
  if (e.job.end_date && localDateIso(new Date(e.job.end_date)) > localDateIso(new Date(now))) return false;
  return istVorbei(e, now);
}

/** Erster laufender, sonst erster kuenftiger Einsatz. */
export function aktuellerEinsatz(liste: Einsatz[], now: number = Date.now()): Einsatz | null {
  return liste.find((e) => istLaufend(e, now)) ?? liste.find((e) => Date.parse(e.start) >= now) ?? null;
}

/** Google-Maps-Link fuer «Route». */
export function routeUrl(e: Einsatz): string | null {
  const ziel = e.job?.adresse ?? e.job?.ort ?? null;
  if (!ziel) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ziel)}`;
}
