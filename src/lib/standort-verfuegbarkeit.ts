// Standort-Verfuegbarkeit — ist EVENTLINE an einem Tag an einer Location
// verfuegbar? (Regel Mischa 04.11.2026, docs/barakuba/VERTRAG-KALENDER.md)
//
// Pro Tag und Location zaehlen die zugeteilten Personen (standort_mitarbeiter,
// Migration 384; nur aktive interne Konten). Eine Person ist «frei», wenn sie
// an dem Tag
//   - KEINE genehmigte Abwesenheit hat (time_off, status «genehmigt»; offene
//     Krankmeldungen zieht der Cron taeglich auf heute nach, Migration 378), und
//   - KEINEN Einsatz bei einem Auftrag an einer ANDEREN Location hat
//     (job_appointments.assigned_to; Auftrag nicht geloescht/storniert/
//     Partner-Anfrage; Auftrag ohne Location zaehlt als «woanders»). Der ganze
//     Tag zaehlt: jeder Tag, den der Einsatz beruehrt, ist belegt.
// 0 frei ⇒ «nicht», 1 frei ⇒ «knapp», ≥2 ⇒ «frei». Niemand zugeteilt ⇒ keine
// Angabe. Zurueck gehen nur Tage mit stufe != «frei».
//
// Partnersicht: nur Stufe + «EVENTLINE nicht verfügbar» / «EVENTLINE knapp»,
// ohne Namen und ohne Gruende (Datenschutz).
//
// EINE Abfrage pro Tabelle fuer den ganzen Zeitraum (nicht pro Tag). Liest mit
// dem Admin-Client — der Aufrufer hat vorher das Recht geprueft (Partner:
// requirePartnerPortal + partner:belegungsplan:view; intern locations:view).

import type { SupabaseClient } from "@supabase/supabase-js";
import { istPortalRolle } from "@/lib/portals";
import { plusTage } from "@/lib/swiss-time";
import { isoZuZuerich, zuerichZuIso } from "@/lib/stempel-meldungen";
import type { TagVerfuegbarkeit } from "@/lib/standort-kalender";

const ABWESENHEIT_GRUND: Record<string, string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Kompensation",
  frei: "Frei",
  militaer: "Militär",
};

/** Auftrags-Status, deren Einsaetze NICHT als belegt zaehlen. */
const NICHT_BELEGT = new Set(["storniert", "partner_anfrage"]);

export interface Person {
  id: string;
  name: string;
}

/** Zugeteilte Profil-IDs einer Location (standort_mitarbeiter). Intern mit dem
 *  RLS-Client (Policy: locations:view oder Admin), Partner mit Service-Rolle.
 *  Wirft bei DB-Fehler. */
export async function standortMitarbeiterIds(db: SupabaseClient, standortId: string): Promise<string[]> {
  const { data, error } = await db.from("standort_mitarbeiter").select("profile_id").eq("location_id", standortId);
  if (error) throw error;
  return ((data ?? []) as { profile_id: string }[]).map((z) => z.profile_id);
}

/** Aktive interne Personen zu IDs (Name = full_name, sonst E-Mail). */
export async function aktivePersonen(admin: SupabaseClient, ids: readonly string[]): Promise<Person[]> {
  if (ids.length === 0) return [];
  const { data, error } = await admin
    .from("profiles")
    .select("id, full_name, email, role, is_active")
    .in("id", [...ids]);
  if (error) throw error;
  return ((data ?? []) as { id: string; full_name: string | null; email: string | null; role: string | null; is_active: boolean | null }[])
    .filter((p) => p.is_active === true && !istPortalRolle(p.role))
    .map((p) => ({ id: p.id, name: p.full_name?.trim() || p.email || "Unbekannt" }))
    .sort((a, b) => a.name.localeCompare(b.name, "de-CH"));
}

/** Alle Kalendertage von..bis (inklusiv). */
function tage(von: string, bis: string): string[] {
  const out: string[] = [];
  for (let t = von; t <= bis; t = plusTage(t, 1)) out.push(t);
  return out;
}

type Weg = Map<string, Map<string, string>>; // personId → tag → Grund

function wegEintragen(weg: Weg, personId: string, von: string, bis: string, vonTag: string, bisTag: string, grund: string) {
  const a = von > vonTag ? von : vonTag;
  const b = bis < bisTag ? bis : bisTag;
  if (a > b) return;
  let m = weg.get(personId);
  if (!m) weg.set(personId, (m = new Map()));
  for (const t of tage(a, b)) if (!m.has(t)) m.set(t, grund);
}

/**
 * Verfuegbarkeit einer Location fuer [vonTag, bisTag] (Zuercher Tage,
 * inklusiv). `personen` = zugeteilte, aktive Personen. Liefert nur Tage mit
 * stufe != «frei»; [] wenn niemand zugeteilt ist. Wirft bei DB-Fehler.
 */
export async function verfuegbarkeitBerechnen(
  admin: SupabaseClient,
  standortId: string,
  personen: readonly Person[],
  vonTag: string,
  bisTag: string,
  opts: { partnersicht: boolean; grundSichtbar?: boolean },
): Promise<TagVerfuegbarkeit[]> {
  // Datenschutz: Abwesenheitsgrund (Ferien/Krank/Militaer …) nur, wenn der
  // Aufrufer ihn sehen darf (rpc darf_abwesenheitsgrund_sehen, Migration 379).
  // Standard false = sicher: dann immer «abwesend». Einsatz-Gruende bleiben.
  const grundSichtbar = opts.grundSichtbar === true;
  if (personen.length === 0 || vonTag > bisTag) return [];
  const ids = personen.map((p) => p.id);
  const vonIso = zuerichZuIso(vonTag, "00:00");
  const bisIso = zuerichZuIso(plusTage(bisTag, 1), "00:00");
  if (!vonIso || !bisIso) return [];

  const [abwRes, einsRes] = await Promise.all([
    admin
      .from("time_off")
      .select("user_id, type, start_date, end_date")
      .in("user_id", ids)
      .eq("status", "genehmigt")
      .lte("start_date", bisTag)
      .gte("end_date", vonTag),
    admin
      .from("job_appointments")
      .select("assigned_to, start_time, end_time, job:jobs(location_id, status, is_deleted, location:locations(name))")
      .in("assigned_to", ids)
      .not("job_id", "is", null)
      .lt("start_time", bisIso)
      .or(`end_time.gt.${vonIso},and(end_time.is.null,start_time.gte.${vonIso})`),
  ]);
  if (abwRes.error) throw abwRes.error;
  if (einsRes.error) throw einsRes.error;

  const weg: Weg = new Map();
  for (const a of (abwRes.data ?? []) as { user_id: string; type: string; start_date: string; end_date: string }[]) {
    wegEintragen(weg, a.user_id, a.start_date, a.end_date, vonTag, bisTag, grundSichtbar ? (ABWESENHEIT_GRUND[a.type] ?? "abwesend") : "abwesend");
  }

  type JobRoh = { location_id: string | null; status: string | null; is_deleted: boolean | null; location: unknown };
  for (const e of (einsRes.data ?? []) as unknown as { assigned_to: string; start_time: string; end_time: string | null; job: JobRoh | JobRoh[] | null }[]) {
    const job = Array.isArray(e.job) ? e.job[0] : e.job;
    if (!job || job.is_deleted === true || NICHT_BELEGT.has(job.status ?? "")) continue;
    if (job.location_id === standortId) continue; // Einsatz hier = kein Hindernis
    const loc = Array.isArray(job.location) ? job.location[0] : job.location;
    const ortName = (loc as { name?: string | null } | null)?.name?.trim();
    const von = isoZuZuerich(e.start_time).datum;
    // Ende exklusiv: ein Einsatz bis 00:00 belegt den Folgetag nicht.
    let bis = e.end_time && Date.parse(e.end_time) > Date.parse(e.start_time)
      ? isoZuZuerich(new Date(Date.parse(e.end_time) - 60_000).toISOString()).datum
      : von;
    // Ueber Nacht bis in den fruehen Morgen (Ende am Folgetag vor 06:00
    // Zuerich) zaehlt nur zum Starttag — gleiche Regel wie der Kalender
    // (belegungsplan-kalender.tsx).
    if (e.end_time && bis === plusTage(von, 1) && isoZuZuerich(e.end_time).zeit < "06:00") bis = von;
    wegEintragen(weg, e.assigned_to, von, bis, vonTag, bisTag, ortName ? `Einsatz ${ortName}` : "Einsatz auswärts");
  }

  const out: TagVerfuegbarkeit[] = [];
  for (const tag of tage(vonTag, bisTag)) {
    const frei: string[] = [];
    const fehlt: { name: string; grund: string }[] = [];
    for (const p of personen) {
      const grund = weg.get(p.id)?.get(tag);
      if (grund) fehlt.push({ name: p.name, grund });
      else frei.push(p.name);
    }
    if (frei.length >= 2) continue;
    const stufe = frei.length === 0 ? "nicht" : "knapp";
    if (opts.partnersicht) {
      out.push({ tag, stufe, frei: [], weg: [], text: stufe === "nicht" ? "EVENTLINE nicht verfügbar" : "EVENTLINE knapp" });
      continue;
    }
    const wegText = fehlt.map((w) => `${w.name} ${w.grund}`).join(", ");
    const text = stufe === "nicht"
      ? `nicht verfügbar: ${wegText}`
      : `knapp: nur ${frei[0]}${wegText ? ` (${wegText})` : ""}`;
    out.push({ tag, stufe, frei, weg: fehlt, text });
  }
  return out;
}

// ─── Einteilung setzen (Admin) ───────────────────────────────────────────────

export const EINTEILUNG_MAX = 500;

/** Liste von UUIDs aus dem Body pruefen (Duplikate entfernt, klein geschrieben). */
export function uuidListePruefen(roh: unknown, feld: string): { ok: true; ids: string[] } | { ok: false; fehler: string } {
  if (!Array.isArray(roh)) return { ok: false, fehler: `${feld} fehlt` };
  if (roh.length > EINTEILUNG_MAX) return { ok: false, fehler: "Zu viele Einträge" };
  const ids: string[] = [];
  for (const v of roh) {
    if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
      return { ok: false, fehler: `Ungültige ID in ${feld}` };
    }
    ids.push(v.toLowerCase());
  }
  return { ok: true, ids: [...new Set(ids)] };
}

/**
 * Einteilung ersetzen: fuer EINE Location alle Personen (seite =
 * "location") oder fuer EINE Person alle Locations (seite = "person").
 * Fehlende werden entfernt, neue eingefuegt; bestehende bleiben. Schreibt mit
 * `db` (intern: RLS-Client, Policy nur Admin). Wirft bei DB-Fehler.
 */
export async function einteilungSetzen(
  db: SupabaseClient,
  seite: "location" | "person",
  festId: string,
  ids: readonly string[],
  userId: string | null,
): Promise<string[]> {
  const fest = seite === "location" ? "location_id" : "profile_id";
  const andere = seite === "location" ? "profile_id" : "location_id";
  const { data, error } = await db.from("standort_mitarbeiter").select(andere).eq(fest, festId);
  if (error) throw error;
  const vorher = new Set(((data ?? []) as Record<string, string>[]).map((z) => z[andere]));
  const soll = new Set(ids);
  const weg = [...vorher].filter((id) => !soll.has(id));
  const neu = [...soll].filter((id) => !vorher.has(id));
  if (weg.length > 0) {
    const { error: dErr } = await db.from("standort_mitarbeiter").delete().eq(fest, festId).in(andere, weg);
    if (dErr) throw dErr;
  }
  if (neu.length > 0) {
    const zeilen = neu.map((id) => ({ [fest]: festId, [andere]: id, erstellt_von: userId }));
    const { error: iErr } = await db
      .from("standort_mitarbeiter")
      .upsert(zeilen, { onConflict: "location_id,profile_id", ignoreDuplicates: true });
    if (iErr) throw iErr;
  }
  return [...soll];
}
