// GET /api/dashboard — konfigurierbares Cockpit-Bundle fuer die Startseite.
//
// Neu (Migration 207): die Rueckgabe folgt einer 3-Ebenen-Konfiguration.
//   Ebene 1  Registry (src/lib/dashboard-widgets.ts) — alle Widget-IDs
//            + Permission-Requirements + Default-Rollen.
//   Ebene 2  Rollen-Override (roles.dashboard_widgets) — pro Rolle
//            {order, hidden}; NULL = Registry-Default fuer diese Rolle.
//   Ebene 3  User-Override (user_dashboard_overrides) — pro User
//            {hidden, widget_order}; leer = Rollen-Zustand uebernehmen.
//
// Merge (deterministisch, kein DB-Sort):
//   roleVisible = roleOrder \ roleHidden   (Registry-unbekannte gefiltert)
//   final       = userOrder (nur was noch in roleVisible und nicht user-
//                            hidden ist) ++ roleVisible-Rest in Rollen-
//                                            Reihenfolge (auch nicht user-hidden).
//   dann Permission-Filter (Admin durch): jedes Widget dessen `requires` der
//   User nicht erfuellt, wird SERVER-seitig entfernt — kein Payload leakt.
//
// Payload-Bau:
//   Wir laden loadAdminData() nur, wenn irgendein Admin-Widget im finalen
//   Set steckt (analog loadMaData). Spart die 10 Counts-Queries fuer reine
//   Techniker-Dashboards und die MA-Compensation-Queries fuer reine Admins.
//
// Response-Shape (rueckwaerts-kompatibel + neu):
//   {
//     success, role, first_name,
//     widgets: string[],           // NEU: sichtbare Widget-IDs in Reihenfolge
//     widget_catalog: [{id,title,requires}], // NEU: Katalog fuer Zahnrad-Modal
//     admin?: {kpi, zu_erledigen, team_status, overdue_jobs},
//     ma?:    {monat_stunden, ist_lohn_chf, wage_exempt, hourly_wage_chf,
//              prognose_stunden, prognose_lohn_chf, naechster_einsatz},
//   }
//   Sensible Zahlen (Lohn): via Admin-Client, aber STRIKT profile_id == user.id.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  bucketizeMinutes,
  todayLocalIso,
  localDateIso,
  ZRH_TZ,
  type MinuteBucket,
} from "@/lib/swiss-time";
import {
  loadLohnDefaults,
  effectivePcts,
  sumEmployeePct,
  type PctComp,
} from "@/lib/employer-costs";
import {
  DASHBOARD_WIDGETS,
  widgetsForRole,
  type WidgetId,
} from "@/lib/dashboard-widgets";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Erster Tag des aktuellen Monats im Europe/Zurich-Kalender als YYYY-MM-DD. */
function currentMonthStartIso(): string {
  const today = todayLocalIso(); // YYYY-MM-DD
  return `${today.slice(0, 7)}-01`;
}

/** Startzeitstempel (UTC-ms) sicher vor Monatsanfang lokal. Nimmt
 *  monthStart YYYY-MM-DD und subtrahiert 2 Tage — damit sind alle
 *  time_entries des Monats sicher enthalten, egal was UTC-Offset macht. */
function safeUtcMsFromLocalDate(iso: string, subtractDays = 2): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - subtractDays * 24 * 3600 * 1000;
}

/** Zurich-Offset ("+01:00"/"+02:00") fuer ein Zurich-Datum YYYY-MM-DD.
 *  Wir brauchen das, um exakt Zurich-Mitternacht als timestamptz-String
 *  gegen jobs.end_date (timestamptz) vergleichen zu koennen — der DB-Server
 *  laeuft in UTC, .lt("end_date", "YYYY-MM-DD") wuerde sonst gegen UTC-
 *  Mitternacht vergleichen und Auftraege 00:00-02:00 Zurich als "ueberfaellig"
 *  markieren, obwohl der neue Tag Zurich-lokal noch nicht angefangen hat. */
function zurichOffsetForDate(dateIso: string): string {
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
function zurichMidnightIso(dateIso: string): string {
  return `${dateIso}T00:00:00${zurichOffsetForDate(dateIso)}`;
}

/** Anzahl volle Tage zwischen zwei Zurich-Datums-Strings (b - a, integer, >= 0). */
function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  const ms = Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da);
  return Math.max(0, Math.round(ms / (24 * 3600 * 1000)));
}

// ---------------------------------------------------------------------------
// Techniker: eigenes Cockpit
// ---------------------------------------------------------------------------

interface MaPayload {
  monat_stunden: number;
  ist_lohn_chf: number;
  wage_exempt: boolean;
  hourly_wage_chf: number | null;
  prognose_stunden: number;
  prognose_lohn_chf: number;
  naechster_einsatz: {
    id: string;
    title: string;
    start_time: string;
    end_time: string | null;
    job_number: number | null;
    job_title: string | null;
    customer_name: string | null;
  } | null;
}

async function loadMaData(userId: string): Promise<MaPayload> {
  const admin = createAdminClient();
  const monthStartIso = currentMonthStartIso(); // YYYY-MM-01
  const monthPrefix = monthStartIso.slice(0, 7); // YYYY-MM
  const nowMs = Date.now();
  const fetchFromMs = safeUtcMsFromLocalDate(monthStartIso, 2);
  // Sichere obere Grenze fuer Appointments-Fetch: erster Tag naechster Monat + 2 Tage.
  const [my, mm] = monthStartIso.split("-").map(Number);
  const monthEndSafeMs = Date.UTC(my, mm, 3); // mm=1..12 -> naechster-Monat-Index; +3 Tage Puffer
  const monthEndSafeIso = new Date(monthEndSafeMs).toISOString();

  // Compensation-Row des Users. Admin-Client umgeht RLS — wir filtern strikt
  // auf profile_id == userId, kein Fremd-Lohn-Leak moeglich.
  const [compRes, entriesRes, defaults, apptsMonthRes, nextApptRes] = await Promise.all([
    admin
      .from("employee_compensation")
      .select("hourly_wage_chf, uses_standard_lohn, wage_exempt, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, effective_from, effective_to")
      .eq("profile_id", userId)
      .lte("effective_from", todayLocalIso())
      .or(`effective_to.is.null,effective_to.gte.${todayLocalIso()}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("time_entries")
      .select("clock_in, clock_out")
      .eq("user_id", userId)
      .not("clock_out", "is", null)
      .gte("clock_in", new Date(fetchFromMs).toISOString()),
    loadLohnDefaults(admin, monthStartIso),
    // Alle eigenen Termine im aktuellen Monat (fuer Prognose)
    admin
      .from("job_appointments")
      .select("start_time, end_time")
      .eq("assigned_to", userId)
      .gte("start_time", new Date(fetchFromMs).toISOString())
      .lt("start_time", monthEndSafeIso),
    // Naechster eigener Termin (>= jetzt)
    admin
      .from("job_appointments")
      .select("id, title, start_time, end_time, job:jobs(job_number, title, customer:customers(name))")
      .eq("assigned_to", userId)
      .gte("start_time", new Date(nowMs).toISOString())
      .order("start_time", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  // §7 (nie stiller Fehlschlag): erster Fehler hochwerfen, damit der aeussere
  // try/catch in GET() 500 + Ursache liefert, statt ein Lohn-Payload mit
  // Nullen aus fehlgeschlagenen Queries.
  const maResErr =
    compRes.error ??
    entriesRes.error ??
    apptsMonthRes.error ??
    nextApptRes.error;
  if (maResErr) throw new Error(maResErr.message);

  // ------- Ist-Stunden diesen Monat (DST-safe via bucketize) -------
  type Entry = { clock_in: string; clock_out: string | null };
  const buckets = new Map<string, MinuteBucket>();
  for (const e of (entriesRes.data ?? []) as Entry[]) {
    if (!e.clock_out) continue;
    bucketizeMinutes(new Date(e.clock_in).getTime(), new Date(e.clock_out).getTime(), buckets);
  }
  let monatMinuten = 0;
  for (const b of buckets.values()) {
    if (b.date.startsWith(monthPrefix)) monatMinuten += b.total_minutes;
  }
  const monatStunden = Math.round((monatMinuten / 60) * 100) / 100;

  // ------- Compensation-Werte -------
  const comp = compRes.data as PctComp & {
    hourly_wage_chf?: number | string | null;
    wage_exempt?: boolean | null;
  } | null;
  const wageExempt = comp?.wage_exempt === true;
  // NaN-Guard: DB koennte Muell liefern (String, "N/A", etc.). Nicht-endliche
  // Werte fallback auf null — ist-Lohn/Prognose gehen dann sauber auf 0.
  const hourlyWage = (() => {
    if (comp?.hourly_wage_chf == null) return null;
    const n = Number(comp.hourly_wage_chf);
    return Number.isFinite(n) ? n : null;
  })();
  const pcts = effectivePcts(comp, defaults);
  const employeeDeductionPct = sumEmployeePct(pcts);
  const nettoFactor = 1 - employeeDeductionPct / 100;

  const istLohn = wageExempt || hourlyWage == null
    ? 0
    : Math.round(monatStunden * hourlyWage * nettoFactor * 100) / 100;

  // ------- Prognose: Ist + zukuenftige geplante Stunden diesen Monat -------
  type Appt = { start_time: string; end_time: string | null };
  let plannedMinuten = 0;
  const nowIso = new Date(nowMs).toISOString();
  for (const a of (apptsMonthRes.data ?? []) as Appt[]) {
    if (!a.end_time) continue;
    // Nur Termine die in DER LOKALEN Monatsansicht liegen und noch nicht
    // vorbei sind. Vergangene Termine sind entweder schon per Stempel
    // erfasst oder gar nicht stattgefunden — beides Wille nicht doppelzaehlen.
    if (a.start_time < nowIso) continue;
    const startDate = localDateIso(new Date(a.start_time));
    if (!startDate.startsWith(monthPrefix)) continue;
    const durMs = new Date(a.end_time).getTime() - new Date(a.start_time).getTime();
    if (durMs > 0) plannedMinuten += durMs / 60000;
  }
  const prognoseStunden = Math.round((monatStunden + plannedMinuten / 60) * 100) / 100;
  const prognoseLohn = wageExempt || hourlyWage == null
    ? 0
    : Math.round(prognoseStunden * hourlyWage * nettoFactor * 100) / 100;

  // ------- Naechster Einsatz -------
  const nextRow = nextApptRes.data as {
    id: string;
    title: string;
    start_time: string;
    end_time: string | null;
    job: {
      job_number: number | null;
      title: string;
      customer: { name: string } | null;
    } | null;
  } | null;
  const naechster = nextRow
    ? {
        id: nextRow.id,
        title: nextRow.title,
        start_time: nextRow.start_time,
        end_time: nextRow.end_time,
        job_number: nextRow.job?.job_number ?? null,
        job_title: nextRow.job?.title ?? null,
        customer_name: nextRow.job?.customer?.name ?? null,
      }
    : null;

  return {
    monat_stunden: monatStunden,
    ist_lohn_chf: istLohn,
    wage_exempt: wageExempt,
    hourly_wage_chf: hourlyWage,
    prognose_stunden: prognoseStunden,
    prognose_lohn_chf: prognoseLohn,
    naechster_einsatz: naechster,
  };
}

// ---------------------------------------------------------------------------
// Admin: Firma-Cockpit
// ---------------------------------------------------------------------------

interface OverdueJobItem {
  id: string;
  job_number: number | null;
  title: string;
  end_date: string;
  days_overdue: number;
  customer_name: string | null;
  location_name: string | null;
}

interface AdminPayload {
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
async function loadAdminData(opts?: {
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
        .neq("role", "partner")
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
      .select("id, job_number, title, end_date, customer:customers(name), location:locations(name)")
      .not("is_deleted", "is", true)
      .not("status", "in", `(${NON_OVERDUE_STATUS.join(",")})`)
      .lt("end_date", todayZurichStartIso)
      .order("end_date", { ascending: true })
      .limit(5),
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
    overdueListRes.error;
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

// ---------------------------------------------------------------------------
// Widget-Merge & Loader-Selection
// ---------------------------------------------------------------------------

/** Loader-Mapping: welche Widgets brauchen welchen Payload-Loader. Bewusst
 *  hier lokal (nicht in der Registry) — die Registry bleibt UI-neutrales
 *  Config-Data, das Loader-Mapping ist ein Backend-Detail dieser Route.
 *
 *  Widgets ohne Eintrag (anwesenheitskalender, partner-willkommen) laden
 *  ihre Daten selbst clientseitig — sie brauchen nichts aus admin/ma-Payload. */
type WidgetLoader = "admin" | "ma";
const WIDGET_LOADERS: Partial<Record<WidgetId, WidgetLoader>> = {
  "kpi-offene-auftraege": "admin",
  "kpi-termine-woche": "admin",
  "kpi-nicht-abgerechnet": "admin",
  "overdue-jobs": "admin",
  "zu-erledigen": "admin",
  "team-status": "admin",
  "ma-monat-stunden": "ma",
  "ma-prognose": "ma",
  "ma-naechster-einsatz": "ma",
};

/** Fuegt Rollen- + User-Overrides deterministisch zusammen — siehe Kopf-Doku.
 *  Rueckgabe: Widget-IDs die auf dem Dashboard erscheinen sollen, in
 *  Anzeige-Reihenfolge. Permission-Filter passiert separat spaeter. */
function resolveVisibleWidgets(params: {
  role: string;
  roleOverride: { order: string[]; hidden: string[] } | null;
  userOverride: { hidden: string[]; widget_order: string[] } | null;
}): WidgetId[] {
  const knownIds = new Set(DASHBOARD_WIDGETS.map((w) => w.id));

  // Ebene 2: Rollen-Set. NULL / leer / kaputt -> Registry-Default fuer die Rolle.
  const roleOrderRaw = params.roleOverride?.order ?? [];
  const roleHiddenRaw = new Set(params.roleOverride?.hidden ?? []);
  const roleOrder = (roleOrderRaw.length > 0 ? roleOrderRaw : widgetsForRole(params.role))
    .filter((id): id is WidgetId => knownIds.has(id as WidgetId));
  const roleVisible = roleOrder.filter((id) => !roleHiddenRaw.has(id));

  // Ebene 3: User-Override.
  const userHidden = new Set(params.userOverride?.hidden ?? []);
  const userOrder = params.userOverride?.widget_order ?? [];

  // Greedy Merge: erst vom User bevorzugte IDs in seiner Reihenfolge,
  // dann Rest in Rollen-Reihenfolge — jeweils nur wenn im Rollen-Set und
  // nicht user-hidden.
  const seen = new Set<WidgetId>();
  const result: WidgetId[] = [];
  for (const raw of userOrder) {
    if (!knownIds.has(raw as WidgetId)) continue;
    const id = raw as WidgetId;
    if (!roleVisible.includes(id)) continue;
    if (userHidden.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of roleVisible) {
    if (userHidden.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Katalog fuer das Zahnrad-Modal — reine Metadaten, kein Payload. Damit
 *  der Client alle Widgets zum Ein-/Ausblenden anbieten kann, egal ob sie
 *  gerade sichtbar sind. */
const WIDGET_CATALOG = DASHBOARD_WIDGETS.map((w) => ({
  id: w.id,
  title: w.title,
  requires: w.requires,
}));

/** Subtitle unter dem Gruss. Serverseitig weil hier die Rolle bekannt ist —
 *  frueher hat der Client hardcoded auf "admin"/"techniker"/"partner"-Slugs
 *  gematcht, was mit dem frei-definierbaren Rollen-System bricht. */
function subtitleForRole(role: string): string {
  if (role === "admin") return "Was jetzt wichtig ist";
  if (role === "techniker") return "Dein Monat auf einen Blick";
  if (role === "partner") return "Willkommen im Portal";
  return "";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const supabase = await createClient();
  const admin = createAdminClient();

  // Profile via anon-Client (RLS: eigenes Profil), Rolle + User-Override
  // via Admin-Client, damit die Route auch wenn die roles-RLS mal restriktiv
  // wird stabil weiter laeuft und ein User-Override immer geladen wird (der
  // User darf sein eigenes lesen, aber wir vermeiden RLS-Reibung).
  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("role, full_name")
    // dev-mode: effective user
    .eq("id", auth.effectiveUserId)
    .single();
  if (profErr || !profile) {
    return NextResponse.json({ success: false, error: "Profil nicht gefunden" }, { status: 500 });
  }

  const firstName = (profile.full_name ?? "").split(" ")[0] ?? "";
  const role = profile.role ?? "";

  try {
    const [roleRes, overrideRes] = await Promise.all([
      admin
        .from("roles")
        .select("permissions, dashboard_widgets, scope")
        .eq("slug", role)
        .maybeSingle(),
      admin
        .from("user_dashboard_overrides")
        .select("hidden, widget_order, widget_spans")
        // dev-mode: effective user
        .eq("user_id", auth.effectiveUserId)
        .maybeSingle(),
    ]);

    // permissions kommt aus jsonb (string[]).
    const permsRaw = roleRes.data?.permissions;
    const permissions: string[] = Array.isArray(permsRaw)
      ? (permsRaw as unknown[]).filter((p): p is string => typeof p === "string")
      : [];

    // Rollen-Override: jsonb {order, hidden} oder NULL.
    let roleOverride: { order: string[]; hidden: string[] } | null = null;
    const rw = roleRes.data?.dashboard_widgets as unknown;
    if (rw && typeof rw === "object" && !Array.isArray(rw)) {
      const obj = rw as { order?: unknown; hidden?: unknown };
      const order = Array.isArray(obj.order)
        ? obj.order.filter((s): s is string => typeof s === "string")
        : [];
      const hidden = Array.isArray(obj.hidden)
        ? obj.hidden.filter((s): s is string => typeof s === "string")
        : [];
      roleOverride = { order, hidden };
    }

    const userOverride = overrideRes.data
      ? {
          hidden: (overrideRes.data.hidden ?? []) as string[],
          widget_order: (overrideRes.data.widget_order ?? []) as string[],
        }
      : null;
    // widget_spans wird separat durchgereicht (nicht Teil von resolveVisibleWidgets,
    // weil die Breite nur die Darstellung beeinflusst, nicht die Sichtbarkeit).
    const userWidgetSpans: Record<string, number> = (() => {
      const raw = overrideRes.data?.widget_spans as unknown;
      if (!raw || typeof raw !== "object") return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "number" && (v === 4 || v === 6 || v === 8 || v === 12)) {
          out[k] = v;
        }
      }
      return out;
    })();

    // 1) Rolle+User mergen (deterministisch).
    const merged = resolveVisibleWidgets({ role, roleOverride, userOverride });

    // 2) Permission-Filter (Admin durch — hasPermission gated).
    const widgets = merged.filter((id) => {
      const w = DASHBOARD_WIDGETS.find((x) => x.id === id);
      if (!w) return false;
      return w.requires.every((p) => hasPermission(permissions, role, p));
    });

    // 3) Payload gezielt laden — nur was ein sichtbares Widget wirklich braucht.
    const loadersNeeded = new Set<WidgetLoader>();
    for (const id of widgets) {
      const l = WIDGET_LOADERS[id];
      if (l) loadersNeeded.add(l);
    }
    // scope fuer Team-Status ermitteln: Admin ist implizit 'all' (analog
    // has_permission()/get_my_scope()). Sonst aus roles.scope, Default 'self'
    // wenn Spalte fehlt (aeltere Rolle vor Migration 208).
    const rawScope = (roleRes.data as { scope?: unknown } | null)?.scope;
    const roleScope: "self" | "team" | "all" =
      rawScope === "team" || rawScope === "all" || rawScope === "self"
        ? rawScope
        : "self";
    const effectiveScope: "self" | "team" | "all" =
      role === "admin" ? "all" : roleScope;
    const [adminData, maData] = await Promise.all([
      loadersNeeded.has("admin")
        // dev-mode: effective user
        ? loadAdminData({ userId: auth.effectiveUserId, scope: effectiveScope })
        : Promise.resolve(null),
      // dev-mode: effective user
      loadersNeeded.has("ma") ? loadMaData(auth.effectiveUserId) : Promise.resolve(null),
    ]);

    const body: Record<string, unknown> = {
      success: true,
      role,
      first_name: firstName,
      subtitle: subtitleForRole(role),
      widgets,
      widget_catalog: WIDGET_CATALOG,
      // Nur Overrides — Frontend faellt auf widgetDefaultSpan(id) zurueck
      // wenn eine ID fehlt. Leere Map == keine Overrides.
      widget_spans: userWidgetSpans,
    };
    if (adminData) body.admin = adminData;
    if (maData) body.ma = maData;

    // no-store: Dashboard-Payload enthaelt live-Zaehler (offene Auftraege,
    // Stempel-Status). 60s stale hiess: neuer Beleg -> Widget zeigt bis zu
    // 60s alten Count. Kein Grund zu cachen — die Requests sind billig.
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
