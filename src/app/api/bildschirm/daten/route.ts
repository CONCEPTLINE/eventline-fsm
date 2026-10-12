// GET /api/bildschirm/daten — Payload des Wand-Dashboards im Buero.
// Zugang ausschliesslich ueber das Bildschirm-Cookie (Migration 285),
// keine App-Session. Rein lesend; bewusst OHNE Geldbetraege (der Monitor
// ist fuer alle im Buero sichtbar) und ohne Dokument-Namen der Ablage.
// Die Zaehler von «Braucht Aufmerksamkeit» kommen aus demselben Loader wie
// das App-Dashboard (ladeAufmerksamkeit) — kein Drift zwischen Wand und Cockpit.
//
// Umbau 2026-10-02 (Leo): linke Haelfte = Agenda ALLER kommenden Auftraege
// (plus Partner-Anfragen und datierte Entwuerfe), unten Auftraege pro
// Woche — damit die Wand auch in ruhigen Zeiten zeigt, was ansteht.
//
// Umbau 2026-10-11 (Leo/Mischa): Heute und Team entfallen; neu «Zuletzt
// passiert» — die juengsten Ereignisse aus Auftraegen, Partner-Portal,
// Einsatzplanung, Rapporten, Todos und Abrechnung (Auswahl 30 Zurich-Tage,
// Zaehler exakt ueber 7 Zurich-Tage). Nie Betraege, Rechnungsnummern,
// Beschreibungen oder Namen von Partner-Personen.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bildschirmSession } from "@/lib/bildschirm";
import { ladeAufmerksamkeit, ALLE_AUFMERKSAMKEIT_RECHTE, zurichMidnightIso } from "@/lib/dashboard-admin-data";
import { todayLocalIso, localDateIso, plusTage } from "@/lib/swiss-time";
import type { BildschirmDaten, BildschirmAuftrag, BildschirmWoche, BildschirmTodo, BildschirmEreignis } from "@/lib/bildschirm-typen";
import { betraegeMaskieren } from "@/app/bildschirm/dashboard/betrag-maske";

export const dynamic = "force-dynamic";

const WOCHEN = 9;
const AGENDA_LIMIT = 60;
const TODO_LIMIT = 200;
/** Je Quelle von «Zuletzt passiert» hoechstens so viele neueste Zeilen. */
const QUELLE_LIMIT = 10;
/** Laenge der zusammengefuehrten Ereignis-Liste. */
const ZULETZT_LISTE = 12;
/** «Neuer Auftrag» / «Partner-Anfrage»: ohne partner_entwurf (nicht
 *  abgeschickt), storniert und Altstatus. */
const NEU_STATUS = ["partner_anfrage", "offen", "abgeschlossen"];

/** ISO-Kalenderwoche eines YYYY-MM-DD. */
function isoWoche(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`);
  const tag = (d.getUTCDay() + 6) % 7; // Mo = 0
  d.setUTCDate(d.getUTCDate() - tag + 3); // Donnerstag dieser Woche
  const ersterDo = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  ersterDo.setUTCDate(ersterDo.getUTCDate() - ((ersterDo.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d.getTime() - ersterDo.getTime()) / (7 * 86400000));
}

/** Alle Zeilen einer Abfrage, seitenweise geladen — ohne das kappt
 *  PostgREST bei max_rows still. `baue` liefert die Abfrage fuer einen
 *  Bereich (stabile Sortierung noetig, sonst ueberlappen die Seiten).
 *  T = Zeilen-Typ des Selects (der Client ist ungetypt, wie ueberall hier). */
async function alleZeilen<T>(
  baue: (von: number, bis: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const SEITE = 1000;
  const alle: T[] = [];
  for (let von = 0; ; von += SEITE) {
    const { data, error } = await baue(von, von + SEITE - 1);
    if (error) throw new Error(error.message);
    alle.push(...((data ?? []) as T[]));
    if (!data || data.length < SEITE) return alle;
  }
}

/** Leerer oder nur aus Leerzeichen bestehender Name → null. */
function nameOderNull(s: string | null | undefined): string | null {
  return s?.trim() || null;
}

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

type TodoRow = {
  id: string;
  title: string;
  priority: string | null;
  due_date: string | null;
  /** Aktuelles Profil der zugewiesenen Person (nicht *_name — das ist nur
   *  der Namens-Verlauf nach einer Profil-Loeschung). */
  person: { id: string; full_name: string | null } | null;
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

/** Neuer Auftrag — Partner erkannt am Ersteller (profiles.partner_location_id,
 *  Migration 096); submitted_at ist bei Partner-Auftraegen nicht verlaesslich. */
type NeuRow = {
  id: string;
  title: string;
  created_at: string;
  location: { name: string } | null;
  creator: { full_name: string | null; partner_location_id: string | null } | null;
};

/** Abgerechnet — invoiced_by aus Migration 079; bewusst ohne Rechnungsnummer/Geld. */
type AbgerechnetRow = {
  id: string;
  title: string;
  invoiced_at: string;
  person: { full_name: string | null } | null;
};

/** Rapport erfasst — nie work_description, client_name, pdf_url, signature_url. */
type RapportRow = {
  id: string;
  created_at: string;
  technician_name: string | null;
  author: { full_name: string | null } | null;
  job: { title: string };
};

/** Todo erledigt — ohne Beschreibung. */
type ErledigtRow = {
  id: string;
  title: string;
  completed_at: string;
  person: { full_name: string | null } | null;
};

/** Termin, der in den letzten 30 Tagen angelegt wurde. */
type TerminNeuRow = {
  job_id: string;
  created_at: string;
  start_time: string;
  job: { title: string; created_at: string };
};

const JOB_SELECT =
  "id, job_number, title, status, priority, start_date, end_date, external_address, " +
  "customer:customers(name), location:locations(name, customer:customers(name)), room:rooms(name), project_lead:profiles!project_lead_id(full_name)";

export async function GET(req: NextRequest) {
  const session = await bildschirmSession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Bildschirm nicht verbunden" }, { status: 401 });
  }
  const admin = createAdminClient();
  const heute = todayLocalIso();
  const heuteStart = new Date(zurichMidnightIso(heute)).toISOString();
  const nowIso = new Date().toISOString();
  // «Zuletzt passiert»: 7 bzw. 30 Zurich-Tage inklusive heute.
  const seit7 = new Date(zurichMidnightIso(plusTage(heute, -6))).toISOString();
  const seit30 = new Date(zurichMidnightIso(plusTage(heute, -29))).toISOString();

  // Wochenraster: Montag der laufenden Woche + 8 weitere Wochen.
  const wochentag = (new Date(`${heute}T12:00:00Z`).getUTCDay() + 6) % 7;
  const montag = plusTage(heute, -wochentag);
  const rasterEndeStart = new Date(zurichMidnightIso(plusTage(montag, WOCHEN * 7))).toISOString();
  const montagStart = new Date(zurichMidnightIso(montag)).toISOString();

  // Offene Todos = exakt die App-Definition (todos-query.ts, use-nav-counts):
  // status 'offen' und nicht geloescht. Aller Personen — der Monitor zeigt
  // das ganze Buero.
  const offeneTodos = (spalten: string, opts?: { count: "exact"; head?: boolean }) =>
    admin.from("todos").select(spalten, opts).eq("status", "offen").is("deleted_at", null);

  // «Zuletzt passiert»: Liste und exakter 7-Tage-Zaehler teilen sich die Filter.
  const neueJobs = (spalten: string, opts?: { count: "exact"; head?: boolean }) =>
    admin.from("jobs").select(spalten, opts).not("is_deleted", "is", true).in("status", NEU_STATUS);
  const abgerechnet = (spalten: string, opts?: { count: "exact"; head?: boolean }) =>
    admin.from("jobs").select(spalten, opts).not("is_deleted", "is", true);
  const rapporte = (spalten: string, opts?: { count: "exact"; head?: boolean }) =>
    admin.from("service_reports").select(spalten, opts).not("job.is_deleted", "is", true).neq("job.status", "storniert");
  const erledigt = (spalten: string, opts?: { count: "exact"; head?: boolean }) =>
    admin.from("todos").select(spalten, opts).eq("status", "erledigt").is("deleted_at", null);

  try {
    const [
      aufmerksamkeit, jobsRes, jobsCountRes, draftsRes, wochenRes, ohnePersonRes, rapportRes, fristenRes, todosRes, todosUeberRes,
      neuRes, neu7Res, abgerRes, abger7Res, rapportListeRes, rapport7Res, erledigtRes, erledigt7Res, termineNeu,
    ] = await Promise.all([
      // Fristen zaehlt die Wand selbst (nur «aktiv», siehe unten).
      ladeAufmerksamkeit({ ...ALLE_AUFMERKSAMKEIT_RECHTE, fristen: false }),
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
      // Fristen der NAS-Ablage: nur bestaetigte («aktiv») — Vorschlaege der
      // lokalen KI entscheidet ein Admin im Tab «Ablage», nicht die Wand.
      admin.from("ablage_fristen").select("id", { count: "exact", head: true }).eq("status", "aktiv").gte("datum", heute).lte("datum", plusTage(heute, 30)),
      // Reihenfolge: Faelligkeit aufsteigend (ueberfaellige stehen damit
      // automatisch vorne, ohne Datum zuletzt), dann dringend vor normal
      // (Text: "dringend" < "normal"), dann aelteste zuerst — neue Todos
      // haengen sich hinten an ihre Gruppe, die Diashow verrutscht kaum.
      offeneTodos("id, title, priority, due_date, person:profiles!assigned_to(id, full_name)", { count: "exact" })
        .order("due_date", { ascending: true, nullsFirst: false })
        .order("priority", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(TODO_LIMIT),
      // due_date ist DATE → Vergleich mit dem Zurich-Tagesdatum als String.
      offeneTodos("id", { count: "exact", head: true }).lt("due_date", heute),

      // ── Zuletzt passiert ──
      // (A) Neue Auftraege und Partner-Anfragen.
      neueJobs("id, title, created_at, location:locations(name), creator:profiles!created_by(full_name, partner_location_id)")
        .gte("created_at", seit30)
        .order("created_at", { ascending: false })
        .limit(QUELLE_LIMIT),
      neueJobs("id", { count: "exact", head: true }).gte("created_at", seit7),
      // (B) Abgerechnet (invoice_skipped_at gehoert nicht dazu).
      abgerechnet("id, title, invoiced_at, person:profiles!invoiced_by(full_name)")
        .gte("invoiced_at", seit30)
        .order("invoiced_at", { ascending: false })
        .limit(QUELLE_LIMIT),
      abgerechnet("id", { count: "exact", head: true }).gte("invoiced_at", seit7),
      // (C) Rapport erfasst (Auftrag nicht geloescht/storniert).
      rapporte("id, created_at, technician_name, author:profiles!created_by(full_name), job:jobs!inner(title, is_deleted, status)")
        .gte("created_at", seit30)
        .order("created_at", { ascending: false })
        .limit(QUELLE_LIMIT),
      rapporte("id, job:jobs!inner(is_deleted, status)", { count: "exact", head: true }).gte("created_at", seit7),
      // (D) Todo erledigt.
      erledigt("id, title, completed_at, person:profiles!assigned_to(full_name)")
        .gte("completed_at", seit30)
        .order("completed_at", { ascending: false })
        .limit(QUELLE_LIMIT),
      erledigt("id", { count: "exact", head: true }).gte("completed_at", seit7),
      // (E) Einsatz geplant: ALLE neuen Termine der 30 Tage (Pakete werden
      // erst im Code gebildet, deshalb kein Limit, sondern seitenweise).
      alleZeilen<TerminNeuRow>((von, bis) =>
        admin
          .from("job_appointments")
          .select("job_id, created_at, start_time, job:jobs!inner(title, status, is_deleted, created_at)")
          .not("job.is_deleted", "is", true)
          .in("job.status", ["offen", "abgeschlossen"])
          .gte("created_at", seit30)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(von, bis),
      ),
    ]);
    const err =
      jobsRes.error ?? jobsCountRes.error ?? draftsRes.error ?? wochenRes.error ?? ohnePersonRes.error ?? rapportRes.error ??
      fristenRes.error ?? todosRes.error ?? todosUeberRes.error ?? neuRes.error ?? neu7Res.error ?? abgerRes.error ??
      abger7Res.error ?? rapportListeRes.error ?? rapport7Res.error ?? erledigtRes.error ?? erledigt7Res.error;
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

    const todoListe: BildschirmTodo[] = ((todosRes.data ?? []) as unknown as TodoRow[]).map((t) => ({
      id: t.id,
      titel: betraegeMaskieren(t.title),
      prioritaet: t.priority === "dringend" ? "dringend" : "normal",
      faellig: t.due_date,
      person: t.person ? { id: t.person.id, name: t.person.full_name?.trim() || "—" } : null,
    }));

    // ── Zuletzt passiert: Quellen zusammenfuehren ──
    // roh = Zeitstempel aus der DB; zeit/tag werden daraus einheitlich gebildet.
    const ereignis = (e: {
      id: string;
      art: BildschirmEreignis["art"];
      roh: string;
      titel: string;
      person: string | null;
      ort?: string | null;
      einsatz_tag?: string | null;
    }): BildschirmEreignis => ({
      id: e.id,
      art: e.art,
      zeit: new Date(e.roh).toISOString(),
      tag: localDateIso(new Date(e.roh)),
      titel: betraegeMaskieren(e.titel),
      person: e.person,
      ort: e.ort ?? null,
      einsatz_tag: e.einsatz_tag ?? null,
    });
    const ereignisse: BildschirmEreignis[] = [];
    for (const j of (neuRes.data ?? []) as unknown as NeuRow[]) {
      // Partner-Auftrag: nur die Location, nie der Name der Partner-Person.
      const partner = !!j.creator?.partner_location_id;
      ereignisse.push(
        ereignis({
          id: `neu:${j.id}`,
          art: partner ? "partner_anfrage" : "auftrag_neu",
          roh: j.created_at,
          titel: j.title,
          person: partner ? null : nameOderNull(j.creator?.full_name),
          ort: partner ? j.location?.name ?? null : null,
        }),
      );
    }
    for (const j of (abgerRes.data ?? []) as unknown as AbgerechnetRow[]) {
      ereignisse.push(ereignis({ id: `abger:${j.id}`, art: "abgerechnet", roh: j.invoiced_at, titel: j.title, person: nameOderNull(j.person?.full_name) }));
    }
    for (const r of (rapportListeRes.data ?? []) as unknown as RapportRow[]) {
      ereignisse.push(
        ereignis({ id: `rapport:${r.id}`, art: "rapport", roh: r.created_at, titel: r.job.title, person: nameOderNull(r.author?.full_name) ?? nameOderNull(r.technician_name) }),
      );
    }
    for (const t of (erledigtRes.data ?? []) as unknown as ErledigtRow[]) {
      ereignisse.push(ereignis({ id: `todo:${t.id}`, art: "todo_erledigt", roh: t.completed_at, titel: t.title, person: nameOderNull(t.person?.full_name) }));
    }
    // Einsatz geplant: Termine, die am Tag der Auftragserfassung angelegt
    // wurden, sind schon «Neuer Auftrag» (sonst stuende der Auftrag doppelt).
    // Der Rest je Auftrag und Anlage-Tag zu einem Paket gebuendelt.
    const pakete = new Map<string, { job_id: string; tag: string; titel: string; zeit: string; zeitMs: number; ersterStartMs: number }>();
    for (const a of termineNeu) {
      const tag = localDateIso(new Date(a.created_at));
      if (tag === localDateIso(new Date(a.job.created_at))) continue;
      const key = `${a.job_id}|${tag}`;
      const zeitMs = new Date(a.created_at).getTime();
      const startMs = new Date(a.start_time).getTime();
      const p = pakete.get(key);
      if (!p) {
        pakete.set(key, { job_id: a.job_id, tag, titel: a.job.title, zeit: a.created_at, zeitMs, ersterStartMs: startMs });
        continue;
      }
      if (zeitMs > p.zeitMs) {
        p.zeit = a.created_at;
        p.zeitMs = zeitMs;
      }
      if (startMs < p.ersterStartMs) p.ersterStartMs = startMs;
    }
    const seit7Ms = new Date(seit7).getTime();
    let pakete7 = 0;
    for (const p of pakete.values()) {
      if (p.zeitMs >= seit7Ms) pakete7 += 1;
      ereignisse.push(
        ereignis({
          id: `einsatz:${p.job_id}:${p.tag}`,
          art: "einsatz_geplant",
          roh: p.zeit,
          titel: p.titel,
          person: null,
          einsatz_tag: localDateIso(new Date(p.ersterStartMs)),
        }),
      );
    }
    ereignisse.sort((a, b) => b.zeit.localeCompare(a.zeit) || a.id.localeCompare(b.id));

    const body: BildschirmDaten = {
      success: true,
      jetzt: new Date().toISOString(),
      auftraege: agenda,
      wochen,
      todos: {
        offen: todosRes.count ?? todoListe.length,
        ueberfaellig: todosUeberRes.count ?? 0,
        liste: todoListe,
      },
      zuletzt: {
        anzahl_7_tage: (neu7Res.count ?? 0) + (abger7Res.count ?? 0) + (rapport7Res.count ?? 0) + (erledigt7Res.count ?? 0) + pakete7,
        seit_7_tage: seit7,
        liste: ereignisse.slice(0, ZULETZT_LISTE),
      },
      kpi: {
        auftraege_geplant: jobsCountRes.count ?? jobs.length,
      },
      // Alle Rechte gesetzt → kein Zaehler ist null; «?? 0» nur fuer den Typ
      // (gleiche Zuordnung wie loadAdminData im App-Dashboard-Loader).
      achtung: {
        partner_anfragen: aufmerksamkeit.partner_anfragen ?? 0,
        ueberfaellige_auftraege: aufmerksamkeit.ueberfaellig?.anzahl ?? 0,
        termine_ohne_person: ohnePersonRes.count ?? 0,
        rapport_entwuerfe: rapportRes.count ?? 0,
        nicht_abgerechnet: aufmerksamkeit.nicht_abgerechnet ?? 0,
        ferien_pending: aufmerksamkeit.abwesenheits_antraege ?? 0,
        neue_belege: aufmerksamkeit.neue_belege ?? 0,
        offene_tickets: aufmerksamkeit.offene_tickets ?? 0,
        fristen_30_tage: fristenRes.count ?? 0,
      },
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
