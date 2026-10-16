// Partnerportal — fachliche Regeln an EINER Stelle (Leo 2026-10-15: Partner
// sehen nur noch ihre EIGENEN Anfragen, mit genau den Angaben, die das Portal
// anzeigt). Genutzt von den Server-Routen unter /api/partner/** und vom
// Portal-UI (Sperrfrist). Reine Funktionen — keine DB, gut testbar.

import { isUuid } from "@/lib/search-escape";
import { localDateIso, todayLocalIso } from "@/lib/swiss-time";

/** Status, in denen die Anfrage noch beim Partner liegt (vor dem Entscheid
 *  von EVENTLINE): Titel, Termine, Absenden, Zurueckziehen. */
export const PARTNER_OFFENE_STATUS = ["partner_entwurf", "partner_anfrage"] as const;

/** Notizen und Dokumente bleiben auch nach der Bestaetigung offen (Nachreichen);
 *  bei abgeschlossen/storniert ist die Beziehung zu Ende. */
export const PARTNER_NACHREICHEN_STATUS = ["partner_entwurf", "partner_anfrage", "offen"] as const;

/** Portal-Aenderungen einer bestaetigten Anfrage nur bis X Kalendertage
 *  (Europe/Zurich) vor der Veranstaltung — danach direkt mit EVENTLINE. */
export const AENDERUNG_SPERRFRIST_TAGE = 3;

/** Jede Lese-Berechtigung des Partnerportals genuegt, um die EIGENEN Anfragen
 *  zu lesen (bisher RLS: partner:auftraege:view ODER partner:belegungsplan:view;
 *  partner:anfragen:view ist das Recht der Seite «Meine Anfragen»). */
export const PARTNER_LESE_RECHTE = [
  "partner:anfragen:view",
  "partner:auftraege:view",
  "partner:belegungsplan:view",
] as const;

/** Zeitfenster-Arten eines Termins (Migration 268). */
export const TERMIN_ZEIT_MODI = ["fix", "verschiebbar", "deadline"] as const;
export type TerminZeitModusWert = (typeof TERMIN_ZEIT_MODI)[number];

export function istPartnerOffen(status: string | null | undefined): boolean {
  return !!status && (PARTNER_OFFENE_STATUS as readonly string[]).includes(status);
}

export function istNachreichbar(status: string | null | undefined): boolean {
  return !!status && (PARTNER_NACHREICHEN_STATUS as readonly string[]).includes(status);
}

/** Von EVENTLINE bestaetigt: angenommen (accepted_at) oder im Aenderungs-
 *  modus nach «Änderungen vornehmen» (partner_aenderung). */
export function istBestaetigt(job: { accepted_at: string | null; partner_aenderung: unknown }): boolean {
  return job.accepted_at != null || (job.partner_aenderung != null && job.partner_aenderung !== false);
}

/** «Zurückziehen» (= Anfrage samt Terminen und Anhaengen loeschen) nur,
 *  solange die Anfrage beim Partner liegt UND nie bestaetigt wurde (Leo
 *  2026-10-16). Gleiche Regel in partner_withdraw_anfrage (Migration 348). */
export function darfZurueckziehen(job: { status: string; accepted_at: string | null; partner_aenderung: unknown }): boolean {
  return istPartnerOffen(job.status) && !istBestaetigt(job);
}

export const ZURUECKZIEHEN_BESTAETIGT =
  "Die Anfrage ist bereits bestätigt und kann nicht mehr zurückgezogen werden — bitte direkt mit EVENTLINE klären.";

/** Die Spalten, die fuer die Entscheidung «eigene Anfrage» noetig sind. */
export interface AnfrageKern {
  location_id: string | null;
  is_deleted: boolean | null;
  status: string;
  accepted_at: string | null;
  rejected_at: string | null;
  created_by: string | null;
}

/** Standort-Sicht eines Partner-Kontos (aus requirePartnerPortal). */
export interface PartnerStandort {
  standortId: string;
  /** Alle Partner-Konten dieses Standorts (auch deaktivierte). */
  teamIds: readonly string[];
  /** Partner-Konten ANDERER Standorte (bzw. ohne Standort). */
  fremdePartnerIds: readonly string[];
}

/**
 * «Eigene Anfrage» eines Partner-Standorts:
 *   Auftrag am Standort des Partners, nicht geloescht, nicht von einem
 *   Partner-Konto eines anderen Standorts angelegt (z.B. von EVENTLINE
 *   verlegt), UND aus einer Partner-Anfrage entstanden — noch im Partner-
 *   Status (Entwurf/Anfrage), von EVENTLINE angenommen oder abgelehnt
 *   (accepted_at / rejected_at setzt nur der Partner-Entscheid), oder von
 *   einem Konto des Partner-Teams dieses Standorts angelegt.
 * Alles andere am Standort (EVENTLINE-eigene Auftraege, Vermietungen) ist
 * fremd: im Belegungsplan nur «belegt», sonst nicht abrufbar.
 */
export function istEigeneAnfrage(job: AnfrageKern, s: PartnerStandort): boolean {
  if (!s.standortId || job.location_id !== s.standortId || job.is_deleted === true) return false;
  if (job.created_by != null && s.fremdePartnerIds.includes(job.created_by)) return false;
  return (
    istPartnerOffen(job.status) ||
    job.accepted_at != null ||
    job.rejected_at != null ||
    (job.created_by != null && s.teamIds.includes(job.created_by))
  );
}

/** Dieselbe Regel als PostgREST-Filter: jeder Eintrag ist ein `.or(...)`
 *  (mehrere `.or()` verknuepft PostgREST mit UND) — immer zusammen mit
 *  `.eq("location_id", standort)` und `.not("is_deleted", "is", true)`. */
export function eigeneAnfrageFilter(s: Pick<PartnerStandort, "teamIds" | "fremdePartnerIds">): string[] {
  const teile = [
    `status.in.(${PARTNER_OFFENE_STATUS.join(",")})`,
    "accepted_at.not.is.null",
    "rejected_at.not.is.null",
  ];
  const team = s.teamIds.filter((id) => isUuid(id));
  if (team.length > 0) teile.push(`created_by.in.(${team.join(",")})`);
  const filter = [teile.join(",")];
  const fremde = s.fremdePartnerIds.filter((id) => isUuid(id));
  if (fremde.length > 0) filter.push(`created_by.is.null,created_by.not.in.(${fremde.join(",")})`);
  return filter;
}

/** Namen der EVENTLINE-Mitarbeitenden, die Terminen dieser Anfrage zugeteilt
 *  sind — jede Person einmal, in Termin-Reihenfolge. `namen` enthaelt nur
 *  interne Konten (interneNamen in partner-portal-server.ts). */
export function zugewieseneNamen(
  jobId: string,
  zuteilungen: readonly { job_id: string; assigned_to: string | null }[],
  namen: ReadonlyMap<string, string>,
): string[] {
  const liste: string[] = [];
  for (const t of zuteilungen) {
    if (t.job_id !== jobId || !t.assigned_to) continue;
    const name = namen.get(t.assigned_to);
    if (name && !liste.includes(name)) liste.push(name);
  }
  return liste;
}

export type PartnerBuchung =
  | { id: string; eigen: true; title: string; status: string; start_date: string | null; end_date: string | null; zugewiesen: string[] }
  | { id: string; eigen: false; start_date: string | null; end_date: string | null };

/**
 * Belegungsplan aus Sicht des Partners: eigene Anfragen mit Titel, Status und
 * Zugeteilten; alles andere am Standort nur als «belegt» — Zeitraum mit
 * kuenstlicher ID, ohne Titel, Nummer, Kunde oder Status (Leo 2026-10-15).
 * Stornierte fremde Eintraege fallen weg (der Tag ist frei), abgelehnte
 * eigene Anfragen bleiben sichtbar.
 */
export function partnerBelegungen(
  jobs: readonly (AnfrageKern & { id: string; title: string; start_date: string | null; end_date: string | null })[],
  s: PartnerStandort,
  zuteilungen: readonly { job_id: string; assigned_to: string | null }[],
  namen: ReadonlyMap<string, string>,
): PartnerBuchung[] {
  let n = 0;
  return jobs.flatMap((j): PartnerBuchung[] => {
    if (istEigeneAnfrage(j, s)) {
      return [{
        id: j.id, eigen: true, title: j.title, status: j.status,
        start_date: j.start_date, end_date: j.end_date,
        zugewiesen: zugewieseneNamen(j.id, zuteilungen, namen),
      }];
    }
    if (j.status === "storniert") return [];
    n += 1;
    return [{ id: `belegt-${n}`, eigen: false, start_date: j.start_date, end_date: j.end_date }];
  });
}

/** Ablage-Ordner der Partner-Anhaenge einer Anfrage (Job-ID klein, wie
 *  job_id::text). */
export function partnerOrdner(jobId: string): string {
  return `partner-anfragen/${jobId.toLowerCase()}/`;
}

/**
 * Darf der Partner dieses Dokument seiner eigenen Anfrage sehen und laden?
 * Ja fuer alle Dokumente von EVENTLINE (Hochlader kein Portal-Konto, auch
 * System-Ablagen ohne Hochlader) und fuer Partner-Anhaenge im Anfrage-Ordner;
 * nie fuer Dokumente anderer Portal-Konten (Lieferanten-Angebote). Gleiche
 * Regel wie bisher die Storage-Grenze (profil_ist_portal, Migration 329).
 */
export function dokumentFuerPartner(
  doc: { storage_path: string | null; uploaded_by: string | null },
  jobId: string,
  portalKonten: ReadonlySet<string>,
): boolean {
  const pfad = doc.storage_path ?? "";
  if (!pfad || pfad.includes("..")) return false;
  if (!doc.uploaded_by || !portalKonten.has(doc.uploaded_by)) return true;
  return pfad.startsWith(partnerOrdner(jobId));
}

/** Kalendertage (Europe/Zurich) von heute bis zum Veranstaltungsbeginn;
 *  null ohne Datum. */
export function tageBisVeranstaltung(startDate: string | null | undefined, heute: string = todayLocalIso()): number | null {
  if (!startDate) return null;
  const t = new Date(startDate);
  if (Number.isNaN(t.getTime())) return null;
  return Math.round((Date.parse(localDateIso(t)) - Date.parse(heute)) / 86_400_000);
}

export function aenderungGesperrt(startDate: string | null | undefined, heute?: string): boolean {
  const tage = tageBisVeranstaltung(startDate, heute);
  return tage !== null && tage < AENDERUNG_SPERRFRIST_TAGE;
}

const ISO_ZEITPUNKT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Zeitpunkt aus dem Browser (mit Zeitzone, z.B. "2026-11-14T18:00:00+01:00"). */
export function istIsoZeitpunkt(v: unknown): v is string {
  return typeof v === "string" && ISO_ZEITPUNKT_RE.test(v) && !Number.isNaN(Date.parse(v));
}

export interface TerminEingabe {
  titel: string;
  start: string;
  ende: string | null;
  beschreibung: string | null;
  zeitModus: TerminZeitModusWert;
}

/** Plausibilitaets-Grenzen gegen Missbrauch — weit ueber jeder echten
 *  Eingabe (laengster Titel heute 99 Zeichen), bisher galt keine Grenze. Der
 *  Titel einer bestehenden Anfrage bleibt bei 200 (partner_update_title). */
export const KURZTEXT_MAX = 500;
export const TEXT_MAX = 20_000;
export const NOTIZEN_MAX = 50_000;

/**
 * Termin-Eingabe pruefen — dieselben Regeln wie bisher im Portal und in der
 * RPC partner_update_termin: Titel und Beginn Pflicht, gueltige Zeitfenster-
 * Art, bei «Fertig bis» (deadline) keine Endzeit, Termin-Tag innerhalb der
 * Veranstaltung (Zuercher Kalendertage).
 */
export function terminPruefen(
  roh: { titel?: unknown; start?: unknown; ende?: unknown; beschreibung?: unknown; zeit_modus?: unknown },
  veranstaltung: { start_date: string | null; end_date: string | null },
): { ok: true; termin: TerminEingabe } | { ok: false; fehler: string } {
  const titel = typeof roh.titel === "string" ? roh.titel.trim() : "";
  if (!titel) return { ok: false, fehler: "Titel fehlt" };
  if (titel.length > KURZTEXT_MAX) return { ok: false, fehler: `Titel ist zu lang (höchstens ${KURZTEXT_MAX} Zeichen)` };
  const zeitModus = (TERMIN_ZEIT_MODI as readonly unknown[]).includes(roh.zeit_modus)
    ? (roh.zeit_modus as TerminZeitModusWert)
    : null;
  if (!zeitModus) return { ok: false, fehler: "Ungültiger Zeitfenster-Modus" };
  if (!istIsoZeitpunkt(roh.start)) return { ok: false, fehler: "Startzeit fehlt" };
  let ende: string | null = null;
  if (zeitModus !== "deadline" && roh.ende != null && roh.ende !== "") {
    if (!istIsoZeitpunkt(roh.ende)) return { ok: false, fehler: "Ungültige Endzeit" };
    ende = roh.ende;
  }
  const beschreibungRoh = typeof roh.beschreibung === "string" ? roh.beschreibung.trim() : "";
  if (beschreibungRoh.length > TEXT_MAX) return { ok: false, fehler: `Beschreibung ist zu lang (höchstens ${TEXT_MAX} Zeichen)` };
  const tag = localDateIso(new Date(roh.start));
  const startTag = veranstaltung.start_date ? localDateIso(new Date(veranstaltung.start_date)) : null;
  const endTag = veranstaltung.end_date ? localDateIso(new Date(veranstaltung.end_date)) : null;
  if (startTag && tag < startTag) return { ok: false, fehler: "Termin liegt vor dem Veranstaltungsbeginn" };
  if (endTag && tag > endTag) return { ok: false, fehler: "Termin liegt nach dem Veranstaltungsende" };
  return { ok: true, termin: { titel, start: roh.start, ende, beschreibung: beschreibungRoh || null, zeitModus } };
}
