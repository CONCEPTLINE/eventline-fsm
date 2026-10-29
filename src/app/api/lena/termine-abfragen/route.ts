// POST /api/lena/termine-abfragen — Leos Termine fuer die Telefonassistentin.
//   Body { von: ISO-Datum/-Zeit, bis?: ISO-Datum/-Zeit }  (ohne Zeitzone = Schweizer Zeit)
//   → { ok, text, termine: [{ start_time, end_time, title }] }
// Nur Termine, die dem Lena-Profil (LENA_USER_ID) gehoeren:
//   - job_appointments mit assigned_to = Profil (mit und ohne Auftrag)
//   - project_appointments mit assigned_to = Profil oder Profil als Teilnehmer
// Zeitraum hoechstens 14 Tage (laenger → gekuerzt und im Text gesagt),
// hoechstens 10 Eintraege, nach Beginn sortiert. Zurueck gehen NUR Zeiten
// (Schweizer Zeit, formatiert) und der Termin-Titel — keine Auftrags-/
// Projektnamen, Kunden, Teilnehmer, Orte oder Beschreibungen.
// Ausgeblendet wie im Kalender: Termine stornierter/geloeschter Auftraege
// und Projekte sowie alter Vermietentwuerfe.

import type { NextRequest } from "next/server";
import { lenaAndereMethoden, lenaAbgelehnt, lenaPost } from "@/lib/lena/server";
import { zeitraumPruefen } from "@/lib/lena/eingabe";
import { LENA_MAX_TERMINE, termineText, vorlesbar } from "@/lib/lena/texte";
import { formatTag, formatUhrzeit, formatZeitraum } from "@/lib/lena/zeit";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const ENDPUNKT = "termine-abfragen";
/** Je Quelle hoechstens so viele Zeilen laden (vor Filter + Zusammenfuehren). */
const HOLEN = 50;

type JobRef = { status: string | null; is_deleted: boolean | null; cancelled_as_anfrage: boolean | null } | null;
type ProjektRef = { status: string | null; is_deleted: boolean | null } | null;
type JobTermin = { start_time: string; end_time: string | null; title: string | null; job: JobRef | JobRef[] };
type ProjektTermin = {
  id: string;
  start_time: string;
  end_time: string | null;
  title: string | null;
  project: ProjektRef | ProjektRef[];
};

const eins = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? x[0] ?? null : x ?? null);

type Termin = { startMs: number; endeMs: number | null; titel: string };

export async function POST(request: NextRequest) {
  return lenaPost(request, ENDPUNKT, async ({ admin, userId, body, jetztMs }) => {
    const z = zeitraumPruefen(body.von, body.bis, jetztMs);
    if (!z.ok) return lenaAbgelehnt(z.text, "Zeitraum ungueltig");
    const { vonMs, bisExklMs, gekuerzt } = z.wert;
    const von = new Date(vonMs).toISOString();
    const bis = new Date(bisExklMs).toISOString();

    const [jobRes, projektRes, teilnahmeRes] = await Promise.all([
      admin
        .from("job_appointments")
        .select("start_time, end_time, title, job:jobs(status, is_deleted, cancelled_as_anfrage)")
        .eq("assigned_to", userId)
        .gte("start_time", von)
        .lt("start_time", bis)
        .order("start_time", { ascending: true })
        .limit(HOLEN),
      admin
        .from("project_appointments")
        .select("id, start_time, end_time, title, project:projects(status, is_deleted)")
        .eq("assigned_to", userId)
        .gte("start_time", von)
        .lt("start_time", bis)
        .order("start_time", { ascending: true })
        .limit(HOLEN),
      admin
        .from("project_appointment_participants")
        .select("appointment:project_appointments!inner(id, start_time, end_time, title, project:projects(status, is_deleted))")
        .eq("profile_id", userId)
        .gte("appointment.start_time", von)
        .lt("appointment.start_time", bis)
        .limit(HOLEN),
    ]);
    if (jobRes.error) throw new Error(`job_appointments: ${jobRes.error.code ?? jobRes.error.message}`);
    if (projektRes.error) throw new Error(`project_appointments: ${projektRes.error.code ?? projektRes.error.message}`);
    if (teilnahmeRes.error) {
      throw new Error(`project_appointment_participants: ${teilnahmeRes.error.code ?? teilnahmeRes.error.message}`);
    }

    const termine: Termin[] = [];
    const zeile = (t: { start_time: string; end_time: string | null; title: string | null }): Termin | null => {
      const startMs = Date.parse(t.start_time);
      if (!Number.isFinite(startMs)) return null;
      const endeMs = t.end_time ? Date.parse(t.end_time) : NaN;
      return { startMs, endeMs: Number.isFinite(endeMs) ? endeMs : null, titel: vorlesbar(t.title, 100) };
    };

    for (const t of (jobRes.data ?? []) as unknown as JobTermin[]) {
      const job = eins(t.job);
      if (job && (job.is_deleted === true || job.status === "storniert" || job.status === "anfrage" || job.cancelled_as_anfrage === true)) {
        continue;
      }
      const z1 = zeile(t);
      if (z1) termine.push(z1);
    }

    const projektTermine = new Map<string, ProjektTermin>();
    for (const t of (projektRes.data ?? []) as unknown as ProjektTermin[]) projektTermine.set(t.id, t);
    for (const p of (teilnahmeRes.data ?? []) as unknown as { appointment: ProjektTermin | ProjektTermin[] }[]) {
      const t = eins(p.appointment);
      if (t) projektTermine.set(t.id, t);
    }
    for (const t of projektTermine.values()) {
      const projekt = eins(t.project);
      if (!projekt || projekt.is_deleted === true || projekt.status === "storniert") continue;
      const z1 = zeile(t);
      if (z1) termine.push(z1);
    }

    termine.sort((a, b) => a.startMs - b.startMs || a.titel.localeCompare(b.titel, "de"));
    const mehr = termine.length > LENA_MAX_TERMINE;
    const auswahl = termine.slice(0, LENA_MAX_TERMINE);

    const text = termineText({
      termine: auswahl.map((t) => ({ zeit: formatZeitraum(t.startMs, t.endeMs, jetztMs), titel: t.titel })),
      mehr,
      vonMs,
      bisExklMs,
      gekuerzt,
      jetztMs,
    });
    const tagUndZeit = (ms: number) => `${formatTag(ms, jetztMs)} ${formatUhrzeit(ms)}`;
    return {
      antwort: {
        ok: true,
        text,
        termine: auswahl.map((t) => ({
          start_time: tagUndZeit(t.startMs),
          end_time: t.endeMs !== null && t.endeMs > t.startMs ? tagUndZeit(t.endeMs) : null,
          title: t.titel,
        })),
      },
      ergebnis: `${auswahl.length} Termine${mehr ? " (weitere vorhanden)" : ""}${gekuerzt ? ", auf 14 Tage gekuerzt" : ""}`,
    };
  });
}

const andere = lenaAndereMethoden(ENDPUNKT);
export const GET = andere.GET;
export const PUT = andere.PUT;
export const PATCH = andere.PATCH;
export const DELETE = andere.DELETE;
export const HEAD = andere.HEAD;
export const OPTIONS = andere.OPTIONS;
