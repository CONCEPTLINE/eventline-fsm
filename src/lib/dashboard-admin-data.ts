// Firmen-Cockpit-Daten (Admin-Payload) — EINE Quelle fuer das App-Dashboard
// (/api/dashboard) und das Wand-Dashboard im Buero (/api/bildschirm/daten),
// damit beide dieselben Zahlen zeigen (2026-10-02, vorher lokal in der
// Dashboard-Route).

import { createAdminClient } from "@/lib/supabase/admin";
import { todayLocalIso, localDateIso, ZRH_TZ } from "@/lib/swiss-time";
import { JOB_FIELDS } from "@/lib/constants";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";

/** Zurich-Offset ("+01:00"/"+02:00") fuer ein Zurich-Datum YYYY-MM-DD.
 *  Wir brauchen das, um exakt Zurich-Mitternacht als timestamptz-String
 *  gegen jobs.end_date (timestamptz) vergleichen zu koennen — der DB-Server
 *  laeuft in UTC, .lt("end_date", "YYYY-MM-DD") wuerde sonst gegen UTC-
 *  Mitternacht vergleichen und Auftraege 00:00-02:00 Zurich als "ueberfaellig"
 *  markieren, obwohl der neue Tag Zurich-lokal noch nicht angefangen hat. */
export function zurichOffsetForDate(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const probeMs = Date.UTC(y, m - 1, d, 12); // Zurich-Mittag ist in beiden Sommer/Winter eindeutig
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZRH_TZ,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(probeMs));
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  // Formen: "GMT+02:00", "GMT+2", "GMT+02"
  const m2 = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m2) return "+01:00";
  const sign = m2[1];
  const hh = m2[2].padStart(2, "0");
  const mm = (m2[3] ?? "00").padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Mitternacht (Anfang) des Zurich-Tages als timestamptz-ISO-String. */
export function zurichMidnightIso(dateIso: string): string {
  return `${dateIso}T00:00:00${zurichOffsetForDate(dateIso)}`;
}

/** Anzahl volle Tage zwischen zwei Zurich-Datums-Strings (b - a, integer, >= 0). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  const ms = Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da);
  return Math.max(0, Math.round(ms / (24 * 3600 * 1000)));
}

export interface OverdueJobItem {
  id: string;
  job_number: number | null;
  title: string;
  end_date: string;
  days_overdue: number;
  customer_name: string | null;
  location_name: string | null;
}

export interface AdminPayload {
  kpi: {
    offene_auftraege: number;
    geplante_termine_woche: number;
    nicht_abgerechnet: number;
  };
  zu_erledigen: {
    ferien_pending: number;
    ueberfaellige_auftraege: number;
    neue_belege: number;
    offene_tickets: number;
    partner_anfragen: number;
  };
  team_status: {
    eingestempelt: number;
    in_ferien_heute: number;
    /** 'all' = firm-weit (Admin/scope='all'), 'team' = nur Team-Mitglieder
     *  (scope='team'), 'self' = nur der User selbst. Wird vom Widget genutzt
     *  um den Titel anzupassen (z.B. "Mein Team" statt "Team-Status"). */
    scope: "all" | "team" | "self";
    /** Personen-Liste fuer das Widget: jede Person im Scope mit Live-Status.
     *  Sortiert: eingestempelt (aelteste zuerst) → abwesend → offline. */
    members: TeamMemberStatus[];
  };
  overdue_jobs: {
    count: number;
    items: OverdueJobItem[];
  };
}

export interface TeamMemberStatus {
  id: string;
  full_name: string;
  status: "eingestempelt" | "abwesend" | "offline";
  /** Nur bei status='eingestempelt': ISO clock_in fuer "seit HH:MM". */
  clock_in: string | null;
  /** Nur bei status='eingestempelt': worauf gestempelt ist —
   *  "INT-123 · Titel" | "PROJ-5 · Titel" | description | "Andere Arbeit". */
  context_label: string | null;
  /** Nur bei status='abwesend': time_off.type (ferien|krank|kompensation|frei|militaer). */
  abwesenheit_typ: string | null;
}

/** Optionen fuer scope-gebundene Zaehler (Migration 208: Team-Leiter-Scope).
 *  `scope='all'` (Admin / scope='all'): keine User-Filter, firm-weite Zahlen.
 *  `scope='team'`: nur Zaehler fuer den User selbst + Mitarbeiter mit
 *  `profiles.team_lead_id = userId`. `scope='self'`: nur der User selbst
 *  (Sicherheitsnetz — kommt in der Praxis kaum vor, weil das Team-Status-
 *  Widget `stempelzeiten:see-all` verlangt). */
export async function loadAdminData(opts?: {
  userId: string;
  scope: "self" | "team" | "all";
}): Promise<AdminPayload> {
  const admin = createAdminClient();
  const today = todayLocalIso();
  const todayZurichStartIso = zurichMidnightIso(today);

  // ---- Team-Status: Sichtbare User-IDs berechnen ----
  // Null = firm-weit (Admin/all). Array = strikt auf diese IDs beschraenken.
  // Der User selbst ist IMMER inkludiert (matches sees_user()-Semantik:
  // target = ich selbst → true). Ein Team-Leiter sieht damit auch seinen
  // eigenen Stempel/Ferien-Status im Widget.
  let scopedUserIds: string[] | null = null;
  const teamScope = opts?.scope ?? "all";
  if (teamScope !== "all" && opts?.userId) {
    if (teamScope === "team") {
      const { data: membersRes, error: membersErr } = await admin
        .from("profiles")
        .select("id")
        .eq("team_lead_id", opts.userId);
      if (membersErr) throw new Error(membersErr.message);
      const memberIds = (membersRes ?? []).map((r) => r.id as string);
      // Duplikat-Guard: sollte der Teamleiter versehentlich sich selbst als
      // team_lead haben, verhindert der Set-Roundtrip Dopplung in der IN-Liste.
      scopedUserIds = Array.from(new Set([opts.userId, ...memberIds]));
    } else {
      // scope='self' — nur der User selbst.
      scopedUserIds = [opts.userId];
    }
  }
  // Auftraege gelten als "ueberfaellig" wenn end_date vor Zurich-Mitternacht-heute
  // liegt UND der Auftrag noch nicht abgeschlossen ist. Draft/Anfrage-Zustaende
  // sind explizit ausgeklammert (existieren als Vor-Auftrag, kein Termindruck).
  const NON_OVERDUE_STATUS = [
    "abgeschlossen",
    "storniert",
    "entwurf",
    "anfrage",
    "partner_anfrage",
    "partner_entwurf",
  ];
  // Rolling 7-Tage-Fenster ab JETZT (nicht Kalender-Woche Mo-So).
  // Kalender-Woche waere am Sonntag/spaeten Samstag leer/irrefuehrend
  // ("Termine diese Woche" zeigt am So 0). Rolling ist immer aussagend.
  const nowMs = Date.now();
  const rollingStartIso = new Date(nowMs).toISOString();
  const rollingEndIso = new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString();

  const [
    offeneAuftraege,
    geplanteTermineWoche,
    nichtAbgerechnet,
    ferienPending,
    ueberfaelligeAuftraege,
    neueBelege,
    offeneTicketsRes,
    openEntriesRes,
    absencesRes,
    teamProfilesRes,
    overdueCountRes,
    overdueListRes,
    partnerAnfragenRes,
  ] = await Promise.all([
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "offen")
      // 3VL-Falle: .neq("is_deleted", true) filtert auch NULL-Zeilen weg
      // (Migration 039 Partial-Indexe / View 040/087 behandeln
      // is_deleted IS NOT TRUE als "nicht geloescht"). Deshalb explizit
      // .not(..., "is", true) — konsistent mit dem Rest der Codebasis.
      .not("is_deleted", "is", true),
    // Termine der naechsten 7 Tage (rolling ab jetzt) — Parent-Job darf
    // nicht soft-deleted sein (is_deleted IS NOT TRUE), sonst zeigt der
    // KPI verwaiste Termine geloeschter Auftraege. Inner-Join + foreignTable-Filter.
    admin
      .from("job_appointments")
      .select("id, job:jobs!inner(is_deleted)", { count: "exact", head: true })
      .gte("start_time", rollingStartIso)
      .lt("start_time", rollingEndIso)
      .not("job.is_deleted", "is", true),
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "abgeschlossen")
      .is("invoiced_at", null)
      .is("invoice_skipped_at", null)
      .not("is_deleted", "is", true),
    admin
      .from("time_off")
      .select("id", { count: "exact", head: true })
      .eq("status", "beantragt"),
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "offen")
      .not("is_deleted", "is", true)
      // CLAUDE.md §4: timestamptz vs YYYY-MM-DD — .lt(today) wuerde gegen
      // UTC-Mitternacht vergleichen, nicht Zurich-Mitternacht (Auftraege
      // mit end_date 22:00-23:59 UTC waeren "faelschlich ueberfaellig").
      // Zurich-Offset explizit anhaengen, konsistent mit overdueCountRes.
      .lt("end_date", todayZurichStartIso),
    admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("type", "beleg")
      .is("filed_at", null)
      .neq("status", "abgelehnt"),
    // Offene Tickets (non-Beleg): stempel_aenderung + material + IT — genau
    // das Set das /tickets zeigt (dort wird beleg per .neq('type','beleg')
    // ausgeblendet, weil Belege ihren eigenen Workflow auf /abrechnung haben
    // und schon via `neue_belege` oben gezaehlt sind — sonst Doppel-Zaehlung).
    // Click-Through fuehrt auf /tickets → Count stimmt mit der Liste ueberein.
    // archived_at wird durch den Daily-Job (Migration 064) erst nach status !=
    // 'offen' gesetzt, ist hier defensiv gefiltert falls sich das mal aendert.
    admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("status", "offen")
      .neq("type", "beleg")
      .is("archived_at", null),
    // Team-Status: offene Stempel MIT Kontext (Job/Projekt) — die Personen-
    // Liste im Widget zeigt "seit HH:MM · INT-123 · Titel". Zaehler werden
    // aus derselben Liste abgeleitet (eine Datenquelle, kein Drift).
    // scopedUserIds=null -> firm-weit; sonst .in('user_id', ids). scopedUserIds
    // enthaelt IMMER mind. den User selbst (siehe oben), .in([]) -> "IN ()"
    // ist damit unmoeglich.
    (() => {
      let q = admin
        .from("time_entries")
        .select("user_id, clock_in, description, job:jobs(job_number, title), project:projects(project_number, title)")
        .is("clock_out", null);
      if (scopedUserIds) q = q.in("user_id", scopedUserIds);
      return q;
    })(),
    // Team-Status: heute abwesend, mit Typ. Gleiches Scoping.
    (() => {
      let q = admin
        .from("time_off")
        .select("user_id, type")
        .eq("status", "genehmigt")
        .lte("start_date", today)
        .gte("end_date", today);
      if (scopedUserIds) q = q.in("user_id", scopedUserIds);
      return q;
    })(),
    // Team-Status: alle Personen im Scope (aktive interne MA) — die Basis-
    // Liste des Widgets. Partner raus (eigenes Portal), Inaktive raus.
    (() => {
      let q = admin
        .from("profiles")
        .select("id, full_name")
        .eq("is_active", true)
        .not("role", "in", PORTAL_ROLLEN_IN)
        .order("full_name");
      if (scopedUserIds) q = q.in("id", scopedUserIds);
      return q;
    })(),
    // Ueberfaellig — Count aller Auftraege deren end_date vor heute (Zurich)
    // liegt und die noch nicht abgeschlossen sind. Hier bewusst kein Filter
    // auf status=offen wie in .zu_erledigen, sondern breiter: alles was
    // "aktiv" ist (nicht abgeschlossen/storniert/entwurf/anfrage).
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .not("is_deleted", "is", true)
      .not("status", "in", `(${NON_OVERDUE_STATUS.join(",")})`)
      .lt("end_date", todayZurichStartIso),
    // Ueberfaellig — Top 5 zur Anzeige, aeltestes-end_date zuerst.
    admin
      .from("jobs")
      .select(`${JOB_FIELDS.core}, end_date, ${JOB_FIELDS.kunde}, ${JOB_FIELDS.location}`)
      .not("is_deleted", "is", true)
      .not("status", "in", `(${NON_OVERDUE_STATUS.join(",")})`)
      .lt("end_date", todayZurichStartIso)
      .order("end_date", { ascending: true })
      .limit(5),
    // Eingegangene Partner-Anfragen (warten auf Annahme/Ablehnung).
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "partner_anfrage")
      .not("is_deleted", "is", true),
  ]);

  // §7 (nie stiller Fehlschlag): Fehlermeldung des ersten fehlgeschlagenen
  // DB-Calls hochwerfen, damit der aeussere try/catch in GET() sauber
  // 500 + Message liefert (Client zeigt Toast). Ohne diesen Check landen
  // fehlende Spalte, RLS-Denial oder Netz-Fehler als "alle Zaehler = 0"
  // im Payload — der User sieht ein "leeres" Dashboard ohne Ursache.
  const adminResErr =
    offeneAuftraege.error ??
    geplanteTermineWoche.error ??
    nichtAbgerechnet.error ??
    ferienPending.error ??
    ueberfaelligeAuftraege.error ??
    neueBelege.error ??
    offeneTicketsRes.error ??
    openEntriesRes.error ??
    absencesRes.error ??
    teamProfilesRes.error ??
    overdueCountRes.error ??
    overdueListRes.error ??
    partnerAnfragenRes.error;
  if (adminResErr) throw new Error(adminResErr.message);

  // ---- Team-Status: Personen-Liste zusammensetzen ----
  type OpenEntryRow = {
    user_id: string;
    clock_in: string;
    description: string | null;
    job: { job_number: number | null; title: string } | { job_number: number | null; title: string }[] | null;
    project: { project_number: number | null; title: string } | { project_number: number | null; title: string }[] | null;
  };
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
  const openByUser = new Map<string, OpenEntryRow>();
  for (const e of (openEntriesRes.data ?? []) as unknown as OpenEntryRow[]) {
    // Pro User max. ein offener Eintrag (Unique-Index) — Map deckt Alt-Daten ab.
    if (!openByUser.has(e.user_id)) openByUser.set(e.user_id, e);
  }
  const absenceByUser = new Map<string, string>();
  for (const a of (absencesRes.data ?? []) as { user_id: string; type: string }[]) {
    if (!absenceByUser.has(a.user_id)) absenceByUser.set(a.user_id, a.type);
  }
  const members: TeamMemberStatus[] = ((teamProfilesRes.data ?? []) as { id: string; full_name: string }[]).map((p) => {
    const open = openByUser.get(p.id);
    if (open) {
      const job = one(open.job);
      const project = one(open.project);
      const context_label = job
        ? `INT-${job.job_number ?? "…"} · ${job.title}`
        : project
        ? `PROJ-${project.project_number ?? "…"} · ${project.title}`
        : open.description || "Andere Arbeit";
      return { id: p.id, full_name: p.full_name, status: "eingestempelt" as const, clock_in: open.clock_in, context_label, abwesenheit_typ: null };
    }
    const absence = absenceByUser.get(p.id);
    if (absence) {
      return { id: p.id, full_name: p.full_name, status: "abwesend" as const, clock_in: null, context_label: null, abwesenheit_typ: absence };
    }
    return { id: p.id, full_name: p.full_name, status: "offline" as const, clock_in: null, context_label: null, abwesenheit_typ: null };
  });
  // Sortierung: eingestempelt (frueheste zuerst) → abwesend → offline; innerhalb alphabetisch.
  const statusRank = { eingestempelt: 0, abwesend: 1, offline: 2 } as const;
  members.sort((a, b) => {
    const r = statusRank[a.status] - statusRank[b.status];
    if (r !== 0) return r;
    if (a.status === "eingestempelt" && b.status === "eingestempelt") {
      return (a.clock_in ?? "").localeCompare(b.clock_in ?? "");
    }
    return a.full_name.localeCompare(b.full_name, "de-CH");
  });

  type OverdueRow = {
    id: string;
    job_number: number | null;
    title: string;
    end_date: string;
    customer: { name: string } | null;
    location: { name: string } | null;
  };
  const overdueItems: OverdueJobItem[] = ((overdueListRes.data ?? []) as unknown as OverdueRow[]).map((r) => ({
    id: r.id,
    job_number: r.job_number,
    title: r.title,
    end_date: r.end_date,
    // Tage seit end_date im Zurich-Kalender — ein Auftrag der gestern faellig
    // war ist "seit 1 Tag" ueberfaellig, unabhaengig von der Uhrzeit.
    days_overdue: daysBetween(localDateIso(new Date(r.end_date)), today),
    customer_name: r.customer?.name ?? null,
    location_name: r.location?.name ?? null,
  }));

  return {
    kpi: {
      offene_auftraege: offeneAuftraege.count ?? 0,
      geplante_termine_woche: geplanteTermineWoche.count ?? 0,
      nicht_abgerechnet: nichtAbgerechnet.count ?? 0,
    },
    zu_erledigen: {
      ferien_pending: ferienPending.count ?? 0,
      ueberfaellige_auftraege: ueberfaelligeAuftraege.count ?? 0,
      neue_belege: neueBelege.count ?? 0,
      offene_tickets: offeneTicketsRes.count ?? 0,
      partner_anfragen: partnerAnfragenRes.count ?? 0,
    },
    team_status: {
      // Zaehler direkt aus der Personen-Liste abgeleitet — keine separate
      // Count-Query mehr, Widget-Liste und Zahlen koennen nicht driften.
      eingestempelt: members.filter((m) => m.status === "eingestempelt").length,
      in_ferien_heute: members.filter((m) => absenceByUser.has(m.id)).length,
      scope: teamScope,
      members,
    },
    overdue_jobs: {
      count: overdueCountRes.count ?? 0,
      items: overdueItems,
    },
  };
}
