// Server-Helfer der Technik-Planung (nur in API-Routen importieren).
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { JOB_STATUS_GESCHLOSSEN } from "@/lib/constants";
import { formatDateFull } from "@/lib/format";
import { TECHNIK_TEXT_MAX, entfernungGesehen } from "@/lib/technik";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { localHour, todayLocalIso } from "@/lib/swiss-time";

const antwort = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

/** Auth-Gate fuer Lieferantenportal-Routen: eingeloggter, aktiver
 *  Portal-User einer AKTIVEN Lieferanten-Firma (deaktivierte Firma = kein
 *  Zugang). Impersonation via effectiveUserId inklusive. Auch von den
 *  Portal-Routen «Wissen»/«Katalog» genutzt. */
export async function requireLieferantPortal(): Promise<
  | { error: NextResponse }
  | {
      error: null;
      admin: SupabaseClient;
      userId: string;
      lieferantId: string;
      lieferantName: string;
      userName: string | null;
    }
> {
  const auth = await requireUser();
  if (auth.error) return { error: auth.error };
  const admin = createAdminClient();
  const { data: profile, error: pErr } = await admin
    .from("profiles")
    .select("role, lieferant_id, is_active, full_name")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (pErr) {
    logError("technik.portal.profil", pErr);
    return { error: antwort("Laden fehlgeschlagen", 500) };
  }
  if (!profile || profile.is_active === false || profile.role !== "lieferant" || !profile.lieferant_id) {
    return { error: antwort("Kein Zugriff", 403) };
  }
  const { data: firma, error: fErr } = await admin
    .from("lieferanten")
    .select("name, is_active")
    .eq("id", profile.lieferant_id)
    .maybeSingle();
  if (fErr) {
    logError("technik.portal.firma", fErr);
    return { error: antwort("Laden fehlgeschlagen", 500) };
  }
  if (!firma || firma.is_active === false) return { error: antwort("Kein Zugriff", 403) };
  return {
    error: null,
    admin,
    userId: auth.effectiveUserId,
    lieferantId: profile.lieferant_id as string,
    lieferantName: (firma.name as string | null) ?? "Lieferant",
    userName: (profile.full_name as string | null) ?? null,
  };
}

/** Storniert/abgeschlossen = Technik-Planung gesperrt (nur noch lesen). */
export function technikGesperrt(status: string | null | undefined): boolean {
  return (JOB_STATUS_GESCHLOSSEN as readonly string[]).includes(status ?? "");
}

export function sperrGrund(status: string | null | undefined): string {
  return status === "storniert"
    ? "Der Auftrag ist storniert — die Technik-Planung ist gesperrt."
    : "Der Auftrag ist abgeschlossen — die Technik-Planung ist gesperrt.";
}

export interface PortalAuftrag {
  zuweisungId: string;
  angefragtAt: string;
  /** Zeitpunkt der vorherigen Anfrage-Runde (Bezug fuer «geaendert»). */
  vorigeAngefragtAt: string | null;
  runden: number;
  job: { id: string; title: string; status: string; jobNumber: number | null; projectLeadId: string | null };
  /** storniert/abgeschlossen: Portal nur noch lesend. */
  gesperrt: boolean;
}

/** Zugriff eines Lieferanten auf einen Auftrag. Sichtbar erst NACH der
 *  ersten Anfrage (angefragt_at gesetzt) — eine blosse Zuweisung bleibt im
 *  Portal unsichtbar. Geloeschte Auftraege = 404. */
export async function lieferantAuftrag(
  admin: SupabaseClient,
  jobId: string,
  lieferantId: string,
): Promise<{ ok: true; auftrag: PortalAuftrag } | { ok: false; antwort: NextResponse }> {
  const { data: zuw, error: zErr } = await admin
    .from("job_lieferanten")
    .select("id, angefragt_at, vorige_angefragt_at, anfrage_runden")
    .eq("job_id", jobId)
    .eq("lieferant_id", lieferantId)
    .maybeSingle();
  if (zErr) {
    logError("technik.portal.zugriff", zErr, { jobId });
    return { ok: false, antwort: antwort("Laden fehlgeschlagen", 500) };
  }
  if (!zuw || !zuw.angefragt_at) return { ok: false, antwort: antwort("Kein Zugriff", 403) };
  const { data: job, error: jErr } = await admin
    .from("jobs")
    .select("id, title, status, job_number, project_lead_id, is_deleted")
    .eq("id", jobId)
    .maybeSingle();
  if (jErr) {
    logError("technik.portal.job", jErr, { jobId });
    return { ok: false, antwort: antwort("Laden fehlgeschlagen", 500) };
  }
  if (!job || job.is_deleted) return { ok: false, antwort: antwort("Auftrag nicht gefunden", 404) };
  return {
    ok: true,
    auftrag: {
      zuweisungId: zuw.id as string,
      angefragtAt: zuw.angefragt_at as string,
      vorigeAngefragtAt: (zuw.vorige_angefragt_at as string | null) ?? null,
      runden: (zuw.anfrage_runden as number | null) ?? 1,
      job: {
        id: job.id as string,
        title: job.title as string,
        status: job.status as string,
        jobNumber: (job.job_number as number | null) ?? null,
        projectLeadId: (job.project_lead_id as string | null) ?? null,
      },
      gesperrt: technikGesperrt(job.status as string),
    },
  };
}

/** Empfaenger fuer Antworten des Lieferanten: die Projektleitung des
 *  Auftrags (project_lead_id, aktiv). Nur wenn keine (aktive) gesetzt ist,
 *  alle mit auftraege:edit — statt jedem Bearbeiter jede Antwort. */
export async function technikAntwortEmpfaenger(
  admin: SupabaseClient,
  projectLeadId: string | null,
  exclude: string[],
): Promise<string[]> {
  if (projectLeadId && !exclude.includes(projectLeadId)) {
    const { data, error } = await admin
      .from("profiles")
      .select("id, is_active, lieferant_id, partner_location_id")
      .eq("id", projectLeadId)
      .maybeSingle();
    if (error) logError("technik.empfaenger.leitung", error);
    if (data?.is_active && !data.lieferant_id && !data.partner_location_id) return [projectLeadId];
  }
  return recipientsWithPermission(admin, "auftraege:edit", { exclude });
}

export interface TechnikAenderungen {
  neu: string[];
  geaendert: string[];
  entfernt: string[];
  /** Juengster Zeitpunkt einer dieser Aenderungen (null = keine). */
  zuletzt: string | null;
}

/** Was hat sich seit `seit` an den Technik-Positionen geaendert? Neu
 *  angelegt, inhaltlich geaendert (Trigger inhalt_geaendert_at) oder
 *  entfernt (Aktivitaet). Fuer die Anfrage-Mail ab Runde 2 und das Portal.
 *  «Entfernt» nur, was der Lieferant gesehen hat (entfernungGesehen):
 *  `aktuelleAnfrage` = Zeitpunkt der laufenden Anfrage (Portal) — eine
 *  danach geloeschte Position aus dieser Anfrage zaehlt mit. */
export async function technikAenderungenSeit(
  admin: SupabaseClient,
  jobId: string,
  seit: string,
  aktuelleAnfrage?: string | null,
): Promise<TechnikAenderungen> {
  const [posRes, aktRes] = await Promise.all([
    admin
      .from("job_technik_positionen")
      .select("menge, bezeichnung, created_at, inhalt_geaendert_at")
      .eq("job_id", jobId)
      .or(`created_at.gt."${seit}",inhalt_geaendert_at.gt."${seit}"`)
      .order("created_at"),
    admin
      .from("job_technik_aktivitaet")
      .select("beschreibung, created_at, meta")
      .eq("job_id", jobId)
      .in("aktion", ["position_geloescht", "ki_entfernt"])
      .gt("created_at", seit)
      .order("created_at"),
  ]);
  if (posRes.error) throw posRes.error;
  if (aktRes.error) throw aktRes.error;
  const b = Date.parse(seit);
  const neu: string[] = [];
  const geaendert: string[] = [];
  let zuletzt = 0;
  for (const p of (posRes.data ?? []) as { menge: number; bezeichnung: string; created_at: string; inhalt_geaendert_at: string | null }[]) {
    const angelegt = Date.parse(p.created_at);
    const geaendertAm = p.inhalt_geaendert_at ? Date.parse(p.inhalt_geaendert_at) : 0;
    if (angelegt > b) neu.push(`${p.menge}× ${p.bezeichnung}`);
    else if (geaendertAm > b) geaendert.push(`${p.menge}× ${p.bezeichnung}`);
    zuletzt = Math.max(zuletzt, angelegt > b ? angelegt : 0, geaendertAm > b ? geaendertAm : 0);
  }
  const entfernt: string[] = [];
  for (const a of (aktRes.data ?? []) as { beschreibung: string; created_at: string; meta: unknown }[]) {
    if (!entfernungGesehen(a, seit, aktuelleAnfrage)) continue;
    zuletzt = Math.max(zuletzt, Date.parse(a.created_at));
    // «Position entfernt: 2× X» / «Aus dem Eingang entfernt: 2× X» → «2× X»
    entfernt.push(a.beschreibung.replace(/^[^:]*:\s*/, ""));
  }
  return { neu, geaendert, entfernt, zuletzt: zuletzt ? new Date(zuletzt).toISOString() : null };
}

/** Beginn des heutigen Tages in Zuerich als Zeitpunkt (ISO, UTC) — fuer
 *  «Aktuell | Vergangen» unabhaengig von der Server-Zeitzone (Vercel = UTC). */
export function zuerichHeuteBeginnIso(): string {
  const tag = todayLocalIso();
  const utcMitternacht = new Date(`${tag}T00:00:00Z`);
  return new Date(utcMitternacht.getTime() - localHour(utcMitternacht) * 3_600_000).toISOString();
}

/** Freitext aus einem Request: getrimmt, Pflicht + Laenge geprueft. */
export function freitext(
  v: unknown,
  opts: { feld: string; max?: number; pflicht?: boolean },
): { wert: string | null; fehler: string | null } {
  const max = opts.max ?? TECHNIK_TEXT_MAX;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return { wert: null, fehler: opts.pflicht ? `${opts.feld} fehlt` : null };
  if (s.length > max) return { wert: null, fehler: `${opts.feld} ist zu lang (höchstens ${max} Zeichen)` };
  return { wert: s, fehler: null };
}

/** Aktivitaets-Eintrag schreiben — Fehler nie werfen (Aktivitaet ist
 *  Protokoll, nicht Fachlogik). */
export async function logTechnik(
  admin: SupabaseClient,
  jobId: string,
  actor: { id: string | null; name: string | null },
  aktion: string,
  beschreibung: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from("job_technik_aktivitaet").insert({
    job_id: jobId,
    actor_id: actor.id,
    actor_name: actor.name,
    aktion,
    beschreibung,
    meta: meta ?? null,
  });
  if (error) logError("technik.aktivitaet", error, { jobId, aktion });
}

/** Anzeigename eines Users (fuer Aktivitaet/Kommentare). */
export async function actorName(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await admin.from("profiles").select("full_name").eq("id", userId).maybeSingle();
  return (data?.full_name as string | undefined) ?? null;
}

/** Aktive Portal-User eines Lieferanten (Notification-Empfaenger). */
export async function lieferantPortalUserIds(admin: SupabaseClient, lieferantId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .eq("role", "lieferant")
    .eq("lieferant_id", lieferantId)
    .eq("is_active", true);
  if (error) logError("technik.portal_user", error, { lieferantId });
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/** Der feste Techniklieferant: genau EIN aktiver Lieferant vom Typ
 *  «technik» (EVENTLINE arbeitet exklusiv mit Herzog Tech — keine Auswahl).
 *  Bei keinem oder mehreren gibt es bewusst KEINE Auswahl, sondern einen
 *  Hinweis im Technik-Tab; Anfragen ist dann gesperrt. */
export async function festerTechnikLieferant(
  admin: SupabaseClient,
): Promise<{ ok: true; lieferant: { id: string; name: string } } | { ok: false; grund: "keiner" | "mehrere" | "fehler" }> {
  const { data, error } = await admin
    .from("lieferanten")
    .select("id, name")
    .eq("is_active", true)
    .eq("type", "technik")
    .limit(2);
  if (error) {
    logError("technik.fester_lieferant", error);
    return { ok: false, grund: "fehler" };
  }
  const rows = (data ?? []) as { id: string; name: string }[];
  if (rows.length === 1) return { ok: true, lieferant: rows[0] };
  return { ok: false, grund: rows.length === 0 ? "keiner" : "mehrere" };
}

/** Zuweisung des festen Techniklieferanten an den Auftrag (null = noch
 *  nie angefragt). Gefiltert auf GENAU diesen Lieferanten — andere
 *  job_lieferanten-Zeilen (z.B. Catering) am selben Auftrag stoeren nicht. */
export async function technikZuweisung(
  admin: SupabaseClient,
  jobId: string,
  lieferantId: string,
): Promise<{ id: string; angefragtAt: string | null; runden: number } | null> {
  const { data, error } = await admin
    .from("job_lieferanten")
    .select("id, angefragt_at, anfrage_runden")
    .eq("job_id", jobId)
    .eq("lieferant_id", lieferantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id as string,
    angefragtAt: (data.angefragt_at as string | null) ?? null,
    runden: (data.anfrage_runden as number | null) ?? 0,
  };
}

/** Datum-Text fuer Mails/Notifications (Europe/Zurich). */
export function jobDatumText(start: string | null, end: string | null): string {
  if (!start) return "";
  const s = formatDateFull(start);
  if (!end || formatDateFull(end) === s) return s;
  return `${s} – ${formatDateFull(end)}`;
}
