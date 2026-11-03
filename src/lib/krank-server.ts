// Krank melden — Server-Teil (Admin-Client). Regeln: lib/krank.ts.
//
// Datenschutz (DSG Art. 5, Gesundheitsdaten): Nachrichten nennen nur «krank
// gemeldet» und den Zeitraum — nie eine Diagnose oder Freitext. Das
// Arztzeugnis liegt im privaten Bucket «arztzeugnisse» (Migration 378) und
// ist nur fuer die Person, Inhaber von ferien:approve und Admins lesbar.

import type { SupabaseClient } from "@supabase/supabase-js";
import { plusTage } from "@/lib/swiss-time";
import { zuerichZuIso } from "@/lib/stempel-meldungen";
import { arztzeugnisFehlt, arztzeugnisLoeschenBis, KRANKMELDUNG, OFFENES_ENDE_VORSCHAU_TAGE } from "@/lib/krank";
import { arztzeugnisPfadPasst } from "@/lib/flow/regeln";
import { logError } from "@/lib/log";

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
    // «Keins da» = nie hochgeladen. Ein an Trust flow übergebenes und hier
    // gelöschtes Zeugnis (pfad null, hochgeladen_at bleibt) ist abgegeben.
    .is("arztzeugnis_pfad", null)
    .is("arztzeugnis_hochgeladen_at", null)
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

/** Höchstens so viele Zeugnisse je Lauf löschen (der Rest folgt am nächsten Tag). */
export const ARZTZEUGNIS_LOESCHEN_JE_LAUF = 200;

/** Arztzeugnisse, die vor ARZTZEUGNIS_LOESCHEN_NACH_TAGEN (lib/krank) an
 *  Trust flow übergeben wurden, im ERP löschen: erst die Datei im Bucket,
 *  dann arztzeugnis_pfad = null. Hochgeladen-/Übergabe-Zeitpunkt, Dateiname,
 *  Typ, Grösse und sha256 bleiben als Beleg. Idempotent; wirft nie (Fehler
 *  landen im Log, der Rest des Crons läuft weiter).
 *  Ein neues Zeugnis (Upload) setzt arztzeugnis_an_flow_at zurück — die
 *  Bedingung auf an_flow_at beim Nullsetzen schützt so eine frische Datei. */
export async function arztzeugnisseNachUebergabeLoeschen(
  admin: SupabaseClient,
  jetzt: Date = new Date(),
  limit: number = ARZTZEUGNIS_LOESCHEN_JE_LAUF,
): Promise<{ geloescht: number; fehler: number }> {
  const bis = arztzeugnisLoeschenBis(jetzt);
  try {
    const { data, error } = await admin
      .from("time_off")
      .select("id, user_id, arztzeugnis_pfad")
      .eq("type", "krank")
      .not("arztzeugnis_pfad", "is", null)
      .not("arztzeugnis_an_flow_at", "is", null)
      .lte("arztzeugnis_an_flow_at", bis)
      .order("arztzeugnis_an_flow_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`Zeugnisse zum Löschen konnten nicht geladen werden: ${error.message}`);
    const zeilen = (data ?? []) as { id: string; user_id: string; arztzeugnis_pfad: string }[];
    if (zeilen.length === 0) return { geloescht: 0, fehler: 0 };

    // Nur Pfade, die zur Abwesenheit gehören (<user_id>/<time_off_id>/…) — nie eine fremde Datei löschen.
    const passend = zeilen.filter((z) => arztzeugnisPfadPasst(z.arztzeugnis_pfad, z.user_id, z.id));
    let fehler = zeilen.length - passend.length;
    if (fehler > 0) {
      logError("cron.arztzeugnis-loeschen.pfad", new Error("Pfad passt nicht zur Abwesenheit — übersprungen"), {
        ids: zeilen.filter((z) => !passend.includes(z)).map((z) => z.id),
      });
    }
    if (passend.length === 0) return { geloescht: 0, fehler };

    // Fehlt die Datei schon, meldet storage.remove keinen Fehler — dann ebenfalls nullen.
    const { error: rmErr } = await admin.storage.from(ARZTZEUGNIS_BUCKET).remove(passend.map((z) => z.arztzeugnis_pfad));
    if (rmErr) throw new Error(`Dateien konnten nicht gelöscht werden: ${rmErr.message}`);

    let geloescht = 0;
    for (const z of passend) {
      const { data: upd, error: uErr } = await admin
        .from("time_off")
        .update({ arztzeugnis_pfad: null })
        .eq("id", z.id)
        .eq("arztzeugnis_pfad", z.arztzeugnis_pfad)
        .lte("arztzeugnis_an_flow_at", bis)
        .select("id");
      if (uErr) {
        fehler++;
        logError("cron.arztzeugnis-loeschen.update", uErr, { id: z.id });
        continue;
      }
      geloescht += upd?.length ?? 0;
    }
    return { geloescht, fehler };
  } catch (e) {
    logError("cron.arztzeugnis-loeschen", e);
    return { geloescht: 0, fehler: 1 };
  }
}
