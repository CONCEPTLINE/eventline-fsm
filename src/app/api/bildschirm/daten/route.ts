// GET /api/bildschirm/daten — Payload des Wand-Dashboards im Buero.
// Zugang ausschliesslich ueber das Bildschirm-Cookie (Migration 285),
// keine App-Session. Rein lesend; bewusst OHNE Geldbetraege (der Monitor
// ist fuer alle im Buero sichtbar) und ohne Dokument-Namen der Ablage.
// Zahlen (Zu erledigen, Team-Status) kommen aus demselben Loader wie das
// App-Dashboard — kein Drift zwischen Wand und Cockpit.
//
// Umbau 2026-10-02 (Leo): linke Haelfte = Agenda ALLER kommenden Auftraege
// (plus Partner-Anfragen und datierte Entwuerfe), unten Auftraege pro
// Woche — damit die Wand auch in ruhigen Zeiten zeigt, was ansteht.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bildschirmSession } from "@/lib/bildschirm";
import { loadAdminData, zurichMidnightIso } from "@/lib/dashboard-admin-data";
import { todayLocalIso, localDateIso, plusTage } from "@/lib/swiss-time";
import type { BildschirmDaten, BildschirmTermin, BildschirmAuftrag, BildschirmWoche } from "@/lib/bildschirm-typen";

export const dynamic = "force-dynamic";

const WOCHEN = 9;
const AGENDA_LIMIT = 60;

/** ISO-Kalenderwoche eines YYYY-MM-DD. */
function isoWoche(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`);
  const tag = (d.getUTCDay() + 6) % 7; // Mo = 0
  d.setUTCDate(d.getUTCDate() - tag + 3); // Donnerstag dieser Woche
  const ersterDo = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  ersterDo.setUTCDate(ersterDo.getUTCDate() - ((ersterDo.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d.getTime() - ersterDo.getTime()) / (7 * 86400000));
}

type TerminRow = {
  id: string;
  title: string;
  start_time: string;
  end_time: string | null;
  zeit_modus: BildschirmTermin["zeit_modus"];
  assigned_to: string | null;
  assigned_to_name: string | null;
  /** Name aus dem Profil — assigned_to_name ist bei aelteren Terminen leer. */
  assignee: { full_name: string | null } | null;
  job: {
    id: string;
    job_number: number | null;
    title: string;
    external_address: string | null;
    customer: { name: string } | null;
    location: { name: string; customer: { name: string } | null } | null;
    room: { name: string } | null;
  } | null;
};

type JobRow = {
  id: string;
  job_number: number | null;
  title: string;
  status: string;
  priority: string | null;
  start_date: string | null;
  end_date: string | null;
  external_address: string | null;
  customer: { name: string } | null;
  location: { name: string; customer: { name: string } | null } | null;
  room: { name: string } | null;
  project_lead: { full_name: string | null } | null;
};

type DraftRow = {
  id: string;
  draft_number: number | null;
  title: string;
  customer_name: string | null;
  location_name: string | null;
  expected_start_date: string;
  expected_end_date: string | null;
  owner_id_name: string | null;
};

const TERMIN_SELECT =
  "id, title, start_time, end_time, zeit_modus, assigned_to, assigned_to_name, assignee:profiles!assigned_to(full_name), " +
  "job:jobs!inner(id, job_number, title, status, is_deleted, external_address, customer:customers(name), location:locations(name, customer:customers(name)), room:rooms(name))";

const JOB_SELECT =
  "id, job_number, title, status, priority, start_date, end_date, external_address, " +
  "customer:customers(name), location:locations(name, customer:customers(name)), room:rooms(name), project_lead:profiles!project_lead_id(full_name)";

/** Mehrere Termine = derselbe Einsatz mit mehreren Personen → eine Zeile. */
function gruppieren(rows: TerminRow[]): BildschirmTermin[] {
  const map = new Map<string, BildschirmTermin>();
  for (const r of rows) {
    const key = `${r.job?.id}|${r.start_time}|${r.end_time ?? ""}|${r.title}`;
    let t = map.get(key);
    if (!t) {
      t = {
        id: r.id,
        titel: r.title,
        start: r.start_time,
        ende: r.end_time,
        zeit_modus: r.zeit_modus,
        auftrag_nr: r.job?.job_number ?? null,
        auftrag_titel: r.job?.title ?? "",
        ort: r.job?.location?.name ?? r.job?.room?.name ?? r.job?.external_address ?? null,
        kunde: r.job?.customer?.name ?? r.job?.location?.customer?.name ?? null,
        personen: [],
      };
      map.set(key, t);
    }
    if (r.assigned_to && !t.personen.some((p) => p.id === r.assigned_to)) {
      t.personen.push({ id: r.assigned_to, name: r.assignee?.full_name ?? r.assigned_to_name ?? "—" });
    }
  }
  return [...map.values()].sort((a, b) => a.start.localeCompare(b.start));
}

export async function GET(req: NextRequest) {
  const session = await bildschirmSession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Bildschirm nicht verbunden" }, { status: 401 });
  }
  const admin = createAdminClient();
  const heute = todayLocalIso();
  const heuteStart = new Date(zurichMidnightIso(heute)).toISOString();
  const morgenStart = new Date(zurichMidnightIso(plusTage(heute, 1))).toISOString();
  const nowIso = new Date().toISOString();

  // Wochenraster: Montag der laufenden Woche + 8 weitere Wochen.
  const wochentag = (new Date(`${heute}T12:00:00Z`).getUTCDay() + 6) % 7;
  const montag = plusTage(heute, -wochentag);
  const rasterEndeStart = new Date(zurichMidnightIso(plusTage(montag, WOCHEN * 7))).toISOString();
  const montagStart = new Date(zurichMidnightIso(montag)).toISOString();

  const termine = () =>
    admin.from("job_appointments").select(TERMIN_SELECT).not("job.is_deleted", "is", true).neq("job.status", "storniert").order("start_time");

  try {
    const [adminData, heuteRes, naechsterRes, jobsRes, jobsCountRes, draftsRes, wochenRes, ohnePersonRes, rapportRes, fristenRes] = await Promise.all([
      loadAdminData(),
      // Heute: beginnt heute ODER hat vor heute begonnen und endet heute/spaeter.
      termine().or(`and(start_time.gte.${heuteStart},start_time.lt.${morgenStart}),and(start_time.lt.${heuteStart},end_time.gte.${heuteStart})`),
      termine().gte("start_time", nowIso).limit(6),
      // Agenda: alles was noch laeuft oder kommt — offene Auftraege + Partner-Anfragen.
      admin
        .from("jobs")
        .select(JOB_SELECT)
        .not("is_deleted", "is", true)
        .in("status", ["offen", "partner_anfrage"])
        .gte("end_date", heuteStart)
        .order("start_date")
        .limit(AGENDA_LIMIT),
      admin
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .not("is_deleted", "is", true)
        .in("status", ["offen", "partner_anfrage"])
        .gte("end_date", heuteStart),
      // Datierte Entwuerfe (noch nicht umgewandelt) — "in Planung".
      admin
        .from("job_drafts")
        .select("id, draft_number, title, customer_name, location_name, expected_start_date, expected_end_date, owner_id_name")
        .not("is_deleted", "is", true)
        .is("converted_to_job_id", null)
        .gte("expected_start_date", heute)
        .order("expected_start_date")
        .limit(20),
      // Einsaetze im Wochenraster (fuer die Balken).
      admin
        .from("job_appointments")
        .select("start_time, job:jobs!inner(is_deleted, status)")
        .not("job.is_deleted", "is", true)
        .neq("job.status", "storniert")
        .gte("start_time", montagStart)
        .lt("start_time", rasterEndeStart),
      admin
        .from("job_appointments")
        .select("id, job:jobs!inner(is_deleted, status)", { count: "exact", head: true })
        .not("job.is_deleted", "is", true)
        .neq("job.status", "storniert")
        .is("assigned_to", null)
        .gte("start_time", nowIso)
        .lt("start_time", new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()),
      admin.from("service_reports").select("id", { count: "exact", head: true }).eq("status", "entwurf"),
      admin.from("ablage_items").select("id", { count: "exact", head: true }).gte("frist", heute).lte("frist", plusTage(heute, 30)),
    ]);
    const err =
      heuteRes.error ?? naechsterRes.error ?? jobsRes.error ?? jobsCountRes.error ?? draftsRes.error ?? wochenRes.error ??
      ohnePersonRes.error ?? rapportRes.error ?? fristenRes.error;
    if (err) throw new Error(err.message);

    const jobs = (jobsRes.data ?? []) as unknown as JobRow[];

    // Termine + Personen je Auftrag der Agenda (zweite Stufe, braucht die IDs).
    const proJob = new Map<string, { einsaetze: number; personen: Set<string> }>();
    if (jobs.length > 0) {
      const { data: apRows, error: apErr } = await admin
        .from("job_appointments")
        .select("job_id, assigned_to, assigned_to_name, assignee:profiles!assigned_to(full_name)")
        .in("job_id", jobs.map((j) => j.id));
      if (apErr) throw new Error(apErr.message);
      for (const a of (apRows ?? []) as unknown as { job_id: string; assigned_to: string | null; assigned_to_name: string | null; assignee: { full_name: string | null } | null }[]) {
        let e = proJob.get(a.job_id);
        if (!e) {
          e = { einsaetze: 0, personen: new Set() };
          proJob.set(a.job_id, e);
        }
        e.einsaetze += 1;
        const name = a.assignee?.full_name ?? a.assigned_to_name;
        if (a.assigned_to && name) e.personen.add(name);
      }
    }

    const agenda: BildschirmAuftrag[] = jobs
      .filter((j) => j.start_date)
      .map((j) => {
        const e = proJob.get(j.id);
        const start = localDateIso(new Date(j.start_date as string));
        return {
          id: j.id,
          typ: j.status === "partner_anfrage" ? "anfrage" : "auftrag",
          nummer: j.job_number,
          titel: j.title,
          kunde: j.customer?.name ?? j.location?.customer?.name ?? null,
          ort: j.location?.name ?? j.room?.name ?? j.external_address ?? null,
          start,
          ende: j.end_date ? localDateIso(new Date(j.end_date)) : start,
          dringend: j.priority === "dringend",
          verantwortlich: j.project_lead?.full_name ?? null,
          einsaetze: e?.einsaetze ?? 0,
          personen: e ? [...e.personen] : [],
        };
      });
    for (const d of (draftsRes.data ?? []) as unknown as DraftRow[]) {
      agenda.push({
        id: d.id,
        typ: "entwurf",
        nummer: d.draft_number,
        titel: d.title,
        kunde: d.customer_name,
        ort: d.location_name,
        start: d.expected_start_date,
        ende: d.expected_end_date ?? d.expected_start_date,
        dringend: false,
        verantwortlich: d.owner_id_name,
        einsaetze: 0,
        personen: [],
      });
    }
    agenda.sort((a, b) => a.start.localeCompare(b.start) || a.titel.localeCompare(b.titel, "de-CH"));

    const wochen: BildschirmWoche[] = Array.from({ length: WOCHEN }, (_, i) => {
      const start = plusTage(montag, i * 7);
      return { kw: isoWoche(start), start, ende: plusTage(start, 6), auftraege: 0, einsaetze: 0 };
    });
    const wocheFuer = (datum: string) => wochen.find((w) => datum >= w.start && datum <= w.ende);
    for (const a of agenda) {
      if (a.typ === "entwurf") continue;
      const w = wocheFuer(a.start);
      if (w) w.auftraege += 1;
    }
    for (const t of (wochenRes.data ?? []) as unknown as { start_time: string }[]) {
      const w = wocheFuer(localDateIso(new Date(t.start_time)));
      if (w) w.einsaetze += 1;
    }

    const body: BildschirmDaten = {
      success: true,
      jetzt: new Date().toISOString(),
      heute: gruppieren((heuteRes.data ?? []) as unknown as TerminRow[]),
      naechster: gruppieren((naechsterRes.data ?? []) as unknown as TerminRow[])[0] ?? null,
      auftraege: agenda,
      wochen,
      team: adminData.team_status.members,
      kpi: {
        im_einsatz: adminData.team_status.eingestempelt,
        auftraege_geplant: jobsCountRes.count ?? jobs.length,
        einsaetze_7_tage: adminData.kpi.geplante_termine_woche,
      },
      achtung: {
        partner_anfragen: adminData.zu_erledigen.partner_anfragen,
        ueberfaellige_auftraege: adminData.overdue_jobs.count,
        termine_ohne_person: ohnePersonRes.count ?? 0,
        rapport_entwuerfe: rapportRes.count ?? 0,
        nicht_abgerechnet: adminData.kpi.nicht_abgerechnet,
        ferien_pending: adminData.zu_erledigen.ferien_pending,
        neue_belege: adminData.zu_erledigen.neue_belege,
        offene_tickets: adminData.zu_erledigen.offene_tickets,
        fristen_30_tage: fristenRes.count ?? 0,
      },
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
