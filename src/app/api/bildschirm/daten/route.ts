// GET /api/bildschirm/daten — Payload des Wand-Dashboards im Buero.
// Zugang ausschliesslich ueber das Bildschirm-Cookie (Migration 285),
// keine App-Session. Rein lesend; bewusst OHNE Geldbetraege (der Monitor
// ist fuer alle im Buero sichtbar) und ohne Dokument-Namen der Ablage.
// Zahlen (KPI, Zu erledigen, Team-Status) kommen aus demselben Loader wie
// das App-Dashboard — kein Drift zwischen Wand und Cockpit.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bildschirmSession } from "@/lib/bildschirm";
import { loadAdminData, zurichMidnightIso } from "@/lib/dashboard-admin-data";
import { todayLocalIso, localDateIso } from "@/lib/swiss-time";
import type { BildschirmDaten, BildschirmTermin, BildschirmTag, BildschirmAuslastung } from "@/lib/bildschirm-typen";

export const dynamic = "force-dynamic";

/** YYYY-MM-DD + n Tage (reine Kalender-Arithmetik, zeitzonenfrei). */
function plusTage(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

type Row = {
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

const SELECT =
  "id, title, start_time, end_time, zeit_modus, assigned_to, assigned_to_name, assignee:profiles!assigned_to(full_name), " +
  "job:jobs!inner(id, job_number, title, status, is_deleted, external_address, customer:customers(name), location:locations(name, customer:customers(name)), room:rooms(name))";

/** Mehrere Termine = derselbe Einsatz mit mehreren Personen → eine Zeile. */
function gruppieren(rows: Row[]): BildschirmTermin[] {
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
  const in8Start = new Date(zurichMidnightIso(plusTage(heute, 8))).toISOString();
  const in14Start = new Date(zurichMidnightIso(plusTage(heute, 14))).toISOString();
  const nowIso = new Date().toISOString();
  const in7Tagen = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  const basis = () =>
    admin.from("job_appointments").select(SELECT).not("job.is_deleted", "is", true).neq("job.status", "storniert").order("start_time");

  try {
    const [adminData, heuteRes, tageRes, auslastungRes, ohnePersonRes, rapportRes, fristenRes] = await Promise.all([
      loadAdminData(),
      // Heute: beginnt heute ODER hat vor heute begonnen und endet heute/spaeter.
      basis().or(`and(start_time.gte.${heuteStart},start_time.lt.${morgenStart}),and(start_time.lt.${heuteStart},end_time.gte.${heuteStart})`),
      basis().gte("start_time", morgenStart).lt("start_time", in8Start),
      admin
        .from("job_appointments")
        .select("start_time, assigned_to, job:jobs!inner(is_deleted, status)")
        .not("job.is_deleted", "is", true)
        .neq("job.status", "storniert")
        .gte("start_time", heuteStart)
        .lt("start_time", in14Start),
      admin
        .from("job_appointments")
        .select("id, job:jobs!inner(is_deleted, status)", { count: "exact", head: true })
        .not("job.is_deleted", "is", true)
        .neq("job.status", "storniert")
        .is("assigned_to", null)
        .gte("start_time", nowIso)
        .lt("start_time", in7Tagen),
      admin.from("service_reports").select("id", { count: "exact", head: true }).eq("status", "entwurf"),
      admin.from("ablage_items").select("id", { count: "exact", head: true }).gte("frist", heute).lte("frist", plusTage(heute, 30)),
    ]);
    const err = heuteRes.error ?? tageRes.error ?? auslastungRes.error ?? ohnePersonRes.error ?? rapportRes.error ?? fristenRes.error;
    if (err) throw new Error(err.message);

    const heuteTermine = gruppieren((heuteRes.data ?? []) as unknown as Row[]);
    const kommende = gruppieren((tageRes.data ?? []) as unknown as Row[]);
    const tage: BildschirmTag[] = Array.from({ length: 7 }, (_, i) => {
      const datum = plusTage(heute, i + 1);
      return { datum, termine: kommende.filter((t) => localDateIso(new Date(t.start)) === datum) };
    });

    const proTag = new Map<string, { termine: number; personen: Set<string> }>();
    for (let i = 0; i < 14; i++) proTag.set(plusTage(heute, i), { termine: 0, personen: new Set() });
    for (const a of (auslastungRes.data ?? []) as unknown as { start_time: string; assigned_to: string | null }[]) {
      const eintrag = proTag.get(localDateIso(new Date(a.start_time)));
      if (!eintrag) continue;
      eintrag.termine += 1;
      if (a.assigned_to) eintrag.personen.add(a.assigned_to);
    }
    const auslastung: BildschirmAuslastung[] = [...proTag.entries()].map(([datum, v]) => ({ datum, termine: v.termine, personen: v.personen.size }));

    const body: BildschirmDaten = {
      success: true,
      jetzt: new Date().toISOString(),
      heute: heuteTermine,
      tage,
      auslastung,
      team: adminData.team_status.members,
      kpi: {
        offene_auftraege: adminData.kpi.offene_auftraege,
        geplante_termine_woche: adminData.kpi.geplante_termine_woche,
        nicht_abgerechnet: adminData.kpi.nicht_abgerechnet,
        im_einsatz: adminData.team_status.eingestempelt,
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
