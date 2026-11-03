// Krank melden — Server-Teil (Admin-Client). Regeln: lib/krank.ts.
//
// Datenschutz (DSG Art. 5, Gesundheitsdaten): Nachrichten nennen nur «krank
// gemeldet» und den Zeitraum — nie eine Diagnose oder Freitext. Das
// Arztzeugnis liegt im privaten Bucket «arztzeugnisse» (Migration 378) und
// ist nur fuer die Person, Inhaber von ferien:approve und Admins lesbar.

import type { SupabaseClient } from "@supabase/supabase-js";
import { plusTage } from "@/lib/swiss-time";
import { zuerichZuIso } from "@/lib/stempel-meldungen";
import { arztzeugnisFehlt, KRANKMELDUNG, OFFENES_ENDE_VORSCHAU_TAGE } from "@/lib/krank";

export const ARZTZEUGNIS_BUCKET = "arztzeugnisse";

export interface BetroffenerEinsatz {
  id: string;
  start: string;
  ende: string | null;
  job_id: string;
  job_number: number;
  titel: string;
  project_lead_id: string | null;
}

/** Letzter Tag, fuer den Einsaetze betroffen sind: bekanntes Ende oder bei
 *  offenem Ende die Vorschau bis zum Tag, ab dem das Arztzeugnis faellig ist. */
export function betroffenBis(ab: string, bis: string | null): string {
  return bis ?? plusTage(ab, OFFENES_ENDE_VORSCHAU_TAGE - 1);
}

/** Eigene Auftrags-Einsaetze im Zeitraum [ab, bis] (Zuercher Kalendertage). */
export async function ladeBetroffeneEinsaetze(
  admin: SupabaseClient,
  userId: string,
  ab: string,
  bis: string,
): Promise<BetroffenerEinsatz[]> {
  const von = zuerichZuIso(ab, "00:00");
  const bisExkl = zuerichZuIso(plusTage(bis, 1), "00:00");
  if (!von || !bisExkl) return [];
  const { data, error } = await admin
    .from("job_appointments")
    .select("id, start_time, end_time, job:jobs(id, job_number, title, project_lead_id, status, is_deleted)")
    .eq("assigned_to", userId)
    .not("job_id", "is", null)
    .gte("start_time", von)
    .lt("start_time", bisExkl)
    .order("start_time", { ascending: true });
  if (error) throw new Error(`Einsätze konnten nicht geladen werden: ${error.message}`);
  type Zeile = {
    id: string; start_time: string; end_time: string | null;
    job: { id: string; job_number: number; title: string; project_lead_id: string | null; status: string; is_deleted: boolean | null } | null;
  };
  return ((data ?? []) as unknown as Zeile[])
    .filter((z) => z.job && !z.job.is_deleted && z.job.status !== "storniert")
    .map((z) => ({
      id: z.id,
      start: z.start_time,
      ende: z.end_time,
      job_id: z.job!.id,
      job_number: z.job!.job_number,
      titel: z.job!.title,
      project_lead_id: z.job!.project_lead_id,
    }));
}

/** Darf `userId` das Arztzeugnis dieser Person sehen? (selbst, ferien:approve, Admin) */
export async function darfArztzeugnisSehen(admin: SupabaseClient, userId: string, besitzerId: string): Promise<boolean> {
  if (userId === besitzerId) return true;
  const { data: p } = await admin.from("profiles").select("role, is_active").eq("id", userId).maybeSingle();
  if (!p || p.is_active !== true) return false;
  if (p.role === "admin") return true;
  const { data: r } = await admin.from("roles").select("permissions").eq("slug", p.role).maybeSingle();
  return Array.isArray(r?.permissions) && (r.permissions as string[]).includes("ferien:approve");
}

/** Taeglicher Abschluss (Cron /api/cron/krank-tagesabschluss, 00:05 Zuerich).
 *  Idempotent — mehrfach am selben Tag laufen schadet nicht.
 *   1. Offenes Ende: end_date auf heute nachziehen (Planung, Kalender und
 *      Lohn lesen end_date — die Person gilt so nie ab Tag 2 als verfuegbar).
 *   2. Arztzeugnis faellig (ab Tag ARZTZEUGNIS_AB_TAG) und keins da: der
 *      Person EINMAL erinnern (arztzeugnis_erinnert_at). Nur Krankmeldungen
 *      der letzten 30 Tage — alte Faelle loesen keine Nachricht mehr aus. */
export async function krankTagesabschluss(
  admin: SupabaseClient,
  heute: string,
  erinnere: (z: { id: string; user_id: string; start_date: string }) => Promise<void>,
): Promise<{ verlaengert: number; erinnert: number }> {
  const { data: verl, error: vErr } = await admin
    .from("time_off")
    .update({ end_date: heute })
    .eq("type", "krank")
    .eq("status", "genehmigt")
    .eq("ende_offen", true)
    .lt("end_date", heute)
    .select("id");
  if (vErr) throw new Error(`Verlängern fehlgeschlagen: ${vErr.message}`);

  const { data: kand, error: kErr } = await admin
    .from("time_off")
    .select("id, user_id, start_date, end_date, ende_offen")
    .eq("type", "krank")
    .eq("status", "genehmigt")
    .eq("approved_by_name", KRANKMELDUNG)
    .is("arztzeugnis_pfad", null)
    .is("arztzeugnis_erinnert_at", null)
    .gte("start_date", plusTage(heute, -30))
    .lte("start_date", heute);
  if (kErr) throw new Error(`Erinnerungen konnten nicht geladen werden: ${kErr.message}`);

  let erinnert = 0;
  for (const z of (kand ?? []) as { id: string; user_id: string; start_date: string; end_date: string; ende_offen: boolean }[]) {
    if (!arztzeugnisFehlt({ ab: z.start_date, bis: z.end_date, endeOffen: z.ende_offen, hatZeugnis: false }, heute)) continue;
    // Erst markieren (nur wenn noch nicht markiert), dann senden — so geht
    // die Erinnerung auch bei parallelen Laeufen nie doppelt raus.
    const { data: markiert, error: mErr } = await admin
      .from("time_off")
      .update({ arztzeugnis_erinnert_at: new Date().toISOString() })
      .eq("id", z.id)
      .is("arztzeugnis_erinnert_at", null)
      .select("id");
    if (mErr) throw new Error(mErr.message);
    if (!markiert || markiert.length === 0) continue;
    await erinnere(z);
    erinnert++;
  }
  return { verlaengert: verl?.length ?? 0, erinnert };
}
