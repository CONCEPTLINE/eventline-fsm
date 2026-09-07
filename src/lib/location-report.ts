/**
 * Location-Report — Datenaggregation fuer den Rentabilitaets-Rapport
 * pro Standort. Server-seitig aufgerufen von /standorte/[id]/report.
 *
 * Grober Aufbau:
 *   - Location-Kopf + Kontakte + Partner-User
 *   - Jobs im Zeitraum (vergangenheit) — status/typ, Kunde, Stunden
 *   - Stunden pro Mitarbeiter (aggregiert)
 *   - Personalkosten = Σ (Stunden × VollkostenProStunde) je Mitarbeiter
 *     Vollkosten/h = Brutto × (1 + AG-Anteil %/100)
 *   - Pipeline (zukunft): geplante Jobs, offene Rentals, Calendar-Events
 *   - Monatsverlauf (historie 24m): Umsatz-Info leer (Bexio), Stunden + Anzahl-Jobs
 *
 * Umsatz: bewusst NICHT enthalten — Rechnungssummen leben in Bexio, nicht
 * in unserer DB. Der Report zeigt die Kosten-Seite (Personal-Vollkosten
 * fuer den Arbeitgeber) und die Aktivitaets-Seite (Anzahl, Stunden, Team).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { effectivePcts, loadLohnDefaults, sumEmployerPct, type LohnPctSet, type PctComp } from "@/lib/employer-costs";

export interface LocationReportPeriod {
  /** ISO YYYY-MM-DD */
  from: string;
  /** ISO YYYY-MM-DD */
  to: string;
  /** Trennlinie 'jetzt' innerhalb from..to */
  today: string;
}

export interface LocationReportKpis {
  total_jobs: number;
  jobs_completed: number;
  jobs_cancelled: number;
  jobs_planned_future: number;
  total_minutes: number;
  personal_vollkosten_chf: number;
  team_size: number;
  /** Umsatz aus Stunden × Verrechnungssatz (historisch pro Stempel-Datum).
   *  NULL wenn Location keine Tiers hat → UI blendet Umsatz/Marge aus. */
  umsatz_chf: number | null;
  marge_chf: number | null;
}

export interface LocationReportJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  customer_name: string | null;
  minutes: number;
  personal_vollkosten_chf: number;
  umsatz_chf: number | null;
  marge_chf: number | null;
  invoiced_at: string | null;
}

export interface LocationReportTierBreakdown {
  tier_id: string;
  key: string;
  label: string;
  minutes: number;
  umsatz_chf: number;
  personal_vollkosten_chf: number;
  marge_chf: number;
}

export interface LocationReportPerson {
  id: string;
  full_name: string;
  role: string | null;
  hourly_wage_chf: number | null;
  employer_pct_sum: number;
  hourly_vollkosten_chf: number;
  minutes: number;
  personal_vollkosten_chf: number;
}

export interface LocationReportContact {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
}

export interface LocationReportMonth {
  ym: string;   // "2026-08"
  minutes: number;
  jobs: number;
}

export interface LocationReportPipelineItem {
  kind: "job" | "rental" | "event";
  id: string;
  title: string;
  date: string | null;
  extra: string | null;
}

export interface LocationReportData {
  location: {
    id: string;
    name: string;
    address_street: string | null;
    address_zip: string | null;
    address_city: string | null;
    capacity: number | null;
    notes: string | null;
    technical_details: string | null;
    default_hourly_rate_chf: number | null;
    customer_name: string | null;
    has_rate_tiers: boolean;
  };
  period: LocationReportPeriod;
  kpis: LocationReportKpis;
  jobs: LocationReportJob[];         // sortiert desc nach Datum
  people: LocationReportPerson[];    // sortiert desc nach Stunden
  contacts: LocationReportContact[];
  partner_users: { id: string; full_name: string; is_active: boolean }[];
  pipeline: LocationReportPipelineItem[];
  months: LocationReportMonth[];     // 24m Historie
  tier_breakdown: LocationReportTierBreakdown[];  // Aufschluesselung nach Modus (leer wenn keine Tiers)
}

interface RawJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  invoiced_at: string | null;
  customer_id: string | null;
}

interface RawTimeEntry {
  clock_in: string;
  clock_out: string | null;
  user_id: string;
  job_id: string | null;
  rate_tier_id?: string | null;
}

interface RawServiceReportRange {
  date?: string;   // "YYYY-MM-DD"
  start?: string;  // "HH:MM"
  end?: string;    // "HH:MM"
  pause?: number;  // Minuten
  rate_tier_id?: string | null;   // optional per-range (Rapport-UI)
}

interface RawServiceReport {
  job_id: string;
  created_by: string;
  time_ranges: RawServiceReportRange[] | null;
}

interface RawTier {
  id: string;
  location_id: string;
  key: string;
  label: string;
  is_default: boolean;
  sort_order: number;
  is_archived: boolean;
}

interface RawTierPrice {
  tier_id: string;
  chf_per_hour: number;
  effective_from: string;   // "YYYY-MM-DD"
  effective_to: string | null;
}

/**
 * Pickt den zum Datum `dateIso` (YYYY-MM-DD) gueltigen Preis fuer einen Tier.
 * Nimmt die Row mit max(effective_from) <= dateIso AND (effective_to IS NULL
 * OR dateIso < effective_to).
 */
function pickTierPrice(prices: RawTierPrice[], tierId: string, dateIso: string): number | null {
  const forTier = prices.filter((p) => p.tier_id === tierId);
  if (forTier.length === 0) return null;
  const active = forTier
    .filter((p) => p.effective_from <= dateIso && (p.effective_to === null || dateIso < p.effective_to))
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return active[0]?.chf_per_hour ?? null;
}

interface RawProfile {
  id: string;
  full_name: string;
  role: string | null;
}

interface RawCompensation {
  profile_id: string;
  hourly_wage_chf: number | null;
  uses_standard_lohn: boolean | null;
  effective_from: string | null;
  effective_to: string | null;
  ahv_iv_eo_pct: number | null;
  alv_pct: number | null;
  nbu_pct: number | null;
  bvg_pct: number | null;
  ktg_pct: number | null;
  quellensteuer_pct: number | null;
  employer_ahv_pct: number | null;
  employer_alv_pct: number | null;
  employer_fak_pct: number | null;
  employer_bu_pct: number | null;
  employer_bvg_pct: number | null;
  employer_verwaltung_pct: number | null;
}

function fmtYm(iso: string): string {
  return iso.slice(0, 7);
}

function minutesBetween(from: string, to: string | null): number {
  const end = to ?? new Date().toISOString();
  const ms = new Date(end).getTime() - new Date(from).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

/**
 * Effektive Compensation-Row fuer einen User zum Zeitpunkt `dateIso`.
 * Nimmt die Row wo effective_from <= dateIso <= (effective_to oder now).
 * Falls keine passende: die zuletzt aktive Row.
 */
function pickCompForDate(
  rows: RawCompensation[],
  userId: string,
  dateIso: string,
): RawCompensation | null {
  const forUser = rows.filter((r) => r.profile_id === userId);
  if (forUser.length === 0) return null;
  const match = forUser.find((r) => {
    if (!r.effective_from) return false;
    if (r.effective_from > dateIso) return false;
    if (r.effective_to && r.effective_to < dateIso) return false;
    return true;
  });
  if (match) return match;
  // Fallback: neueste effective_from vor dateIso, sonst irgendeine.
  const past = forUser
    .filter((r) => r.effective_from && r.effective_from <= dateIso)
    .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""));
  return past[0] ?? forUser[0] ?? null;
}

/**
 * Zurich-Datum als "YYYY-MM-DD". CLAUDE.md §4: NIE toISOString().slice(0,10)
 * fuer Datums-Anzeigen/Vergleiche — das liefert UTC. Zwischen 00-02 CEST
 * ergibt UTC den Vortag → past/future-Klassifizierung wandert.
 */
const zurichDateFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" });
function toZurichDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return zurichDateFmt.format(new Date(iso));
}

export async function loadLocationReport(
  locationId: string,
  from: string,
  to: string,
): Promise<LocationReportData | null> {
  const admin = createAdminClient();
  const today = toZurichDate(new Date().toISOString());

  // ------------------------------------------------------------------
  // Location + Kunde
  // ------------------------------------------------------------------
  const { data: loc } = await admin
    .from("locations")
    .select("*, customer:customers!locations_customer_id_fkey(name)")
    .eq("id", locationId)
    .maybeSingle();
  if (!loc) return null;

  // ------------------------------------------------------------------
  // Parallel: jobs, contacts, partner-users, rentals, events, months
  // ------------------------------------------------------------------
  const [
    jobsRes,
    contactsRes,
    partnerRes,
    rentalsRes,
    eventsRes,
    lohnDefaults,
  ] = await Promise.all([
    // Alle jobs in from..to (inkl. Pipeline: end_date>=from oder Zukunft)
    admin
      .from("jobs")
      .select("id, job_number, title, status, start_date, end_date, invoiced_at, customer_id, customer:customers!jobs_customer_id_fkey(name)")
      .eq("location_id", locationId)
      .neq("is_deleted", true)
      .gte("start_date", from + "T00:00:00Z")
      .lte("start_date", to + "T23:59:59Z")
      .order("start_date", { ascending: false })
      .limit(500),
    admin
      .from("location_contacts")
      .select("id, name, role, email, phone")
      .eq("location_id", locationId)
      .order("name"),
    admin
      .from("profiles")
      .select("id, full_name, is_active")
      .eq("role", "partner")
      .eq("partner_location_id", locationId)
      .order("full_name"),
    // Rentals nur zukunft/aktiv fuer Pipeline
    admin
      .from("rental_requests")
      .select("id, title:notes, event_date, status")
      .eq("location_id", locationId)
      .gte("event_date", today)
      .order("event_date")
      .limit(50),
    admin
      .from("calendar_events")
      .select("id, title, start_date")
      .eq("location_id", locationId)
      .gte("start_date", today + "T00:00:00Z")
      .order("start_date")
      .limit(50),
    loadLohnDefaults(admin, today),
  ]);

  const rawJobs = (jobsRes.data ?? []) as unknown as Array<RawJob & { customer: { name: string } | { name: string }[] | null }>;
  const contacts = (contactsRes.data ?? []) as LocationReportContact[];
  const partnerUsers = (partnerRes.data ?? []) as { id: string; full_name: string; is_active: boolean }[];
  const rentals = (rentalsRes.data ?? []) as { id: string; title: string | null; event_date: string; status: string | null }[];
  const events = (eventsRes.data ?? []) as { id: string; title: string; start_date: string }[];

  // ------------------------------------------------------------------
  // Time entries + Service-Reports (time_ranges) fuer diese Jobs
  // ------------------------------------------------------------------
  const jobIds = rawJobs.map((j) => j.id);
  const [teRes, srRes, tiersRes, tierPricesRes] = await Promise.all([
    jobIds.length > 0
      ? admin
          .from("time_entries")
          .select("clock_in, clock_out, user_id, job_id, rate_tier_id")
          .in("job_id", jobIds)
      : Promise.resolve({ data: [] as RawTimeEntry[] }),
    jobIds.length > 0
      ? admin
          .from("service_reports")
          .select("job_id, created_by, time_ranges")
          .in("job_id", jobIds)
      : Promise.resolve({ data: [] as RawServiceReport[] }),
    // Tiers + Preise dieser Location (fuer Umsatz-Rechnung).
    admin
      .from("location_rate_tiers")
      .select("id, location_id, key, label, is_default, sort_order, is_archived")
      .eq("location_id", locationId),
    // Preise nur der Tiers dieser Location: geht am einfachsten mit einem
    // separaten Query nach dem tiers-Load — hier nutzen wir vereinfacht
    // einen zweiten Query nach dem parallel-Block (siehe unten).
    Promise.resolve({ data: [] as RawTierPrice[] }),
  ]);
  const timeEntries = (teRes.data ?? []) as RawTimeEntry[];
  const serviceReports = (srRes.data ?? []) as RawServiceReport[];
  const tiers = (tiersRes.data ?? []) as RawTier[];
  const activeTiers = tiers.filter((t) => !t.is_archived);
  const defaultTierId = activeTiers.find((t) => t.is_default)?.id ?? activeTiers[0]?.id ?? null;

  // Preise nachladen (nur wenn Tiers existieren — sonst leere Aggregation).
  let tierPrices: RawTierPrice[] = [];
  if (tiers.length > 0) {
    const { data } = await admin
      .from("location_rate_tier_prices")
      .select("tier_id, chf_per_hour, effective_from, effective_to")
      .in("tier_id", tiers.map((t) => t.id));
    tierPrices = (data ?? []) as RawTierPrice[];
  }
  const hasRateTiers = activeTiers.length > 0;
  // Marker um im Promise.all-Fallback nichts zu vergessen:
  void tierPricesRes;

  // Service-Report-Zeiten in ein time_entries-aehnliches Format umbauen,
  // damit die restliche Aggregation-Pipeline unveraendert bleibt. Jeder
  // time_range wird zu einem "synthetischen" Eintrag mit clock_in/-out
  // als volle ISO-Timestamps (lokale Zurich-Zeit als naiv, ohne Timezone-
  // Konversion — die Aggregation zaehlt Minuten-Deltas, Timezone ist
  // hier irrelevant).
  const srAsEntries: RawTimeEntry[] = [];
  for (const sr of serviceReports) {
    if (!Array.isArray(sr.time_ranges)) continue;
    for (const range of sr.time_ranges) {
      if (!range.date || !range.start || !range.end) continue;
      const clockIn = `${range.date}T${range.start}:00`;
      const clockOut = `${range.date}T${range.end}:00`;
      // Pause abziehen indem wir clock_out um pause Minuten reduzieren.
      // Simpler als eine separate Pause-Column im Aggregat.
      const pauseMin = Math.max(0, Number(range.pause ?? 0));
      const outMs = new Date(clockOut).getTime() - pauseMin * 60_000;
      srAsEntries.push({
        clock_in: clockIn,
        clock_out: new Date(outMs).toISOString(),
        user_id: sr.created_by,
        job_id: sr.job_id,
        rate_tier_id: range.rate_tier_id ?? null,   // pro-Range Tier aus Rapport-JSON
      });
    }
  }
  const allEntries: RawTimeEntry[] = [...timeEntries, ...srAsEntries];

  // ------------------------------------------------------------------
  // Compensation-Rows fuer alle beteiligten User (aktiv + historisch)
  // ------------------------------------------------------------------
  const userIds = Array.from(new Set(allEntries.map((t) => t.user_id)));
  const [compsRes, profsRes] = await Promise.all([
    userIds.length > 0
      ? admin
          .from("employee_compensation")
          .select("profile_id, hourly_wage_chf, uses_standard_lohn, effective_from, effective_to, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct")
          .in("profile_id", userIds)
      : Promise.resolve({ data: [] as RawCompensation[] }),
    userIds.length > 0
      ? admin.from("profiles").select("id, full_name, role").in("id", userIds)
      : Promise.resolve({ data: [] as RawProfile[] }),
  ]);
  const comps = (compsRes.data ?? []) as RawCompensation[];
  const profs = (profsRes.data ?? []) as RawProfile[];
  const profileById = new Map(profs.map((p) => [p.id, p]));

  // ------------------------------------------------------------------
  // Aggregation: pro Job Stunden + Vollkosten
  // ------------------------------------------------------------------
  const jobMinutes = new Map<string, number>();
  const jobPersonalKosten = new Map<string, number>();
  const jobUmsatz = new Map<string, number>();          // pro Job
  const personMinutes = new Map<string, number>();
  const personKosten = new Map<string, number>();
  // Tier-Aggregate: pro tier_id → minutes/umsatz/personalKosten
  interface TierAgg { minutes: number; umsatz: number; personalKosten: number; }
  const tierAggByTierId = new Map<string, TierAgg>();
  const addToTier = (tid: string, patch: Partial<TierAgg>) => {
    const cur = tierAggByTierId.get(tid) ?? { minutes: 0, umsatz: 0, personalKosten: 0 };
    cur.minutes += patch.minutes ?? 0;
    cur.umsatz += patch.umsatz ?? 0;
    cur.personalKosten += patch.personalKosten ?? 0;
    tierAggByTierId.set(tid, cur);
  };

  for (const te of allEntries) {
    if (!te.job_id) continue;
    const mins = minutesBetween(te.clock_in, te.clock_out);
    if (mins <= 0) continue;
    const dateIso = te.clock_in.slice(0, 10);

    // Tier + Preis picken. Fallback auf Default-Tier wenn te.rate_tier_id NULL.
    const effTierId = te.rate_tier_id ?? defaultTierId;
    let umsatz = 0;
    if (hasRateTiers && effTierId) {
      const price = pickTierPrice(tierPrices, effTierId, dateIso);
      if (price !== null) umsatz = (price * mins) / 60;
    }

    // Personalkosten (Vollkosten).
    const comp = pickCompForDate(comps, te.user_id, dateIso);
    const brutto = Number(comp?.hourly_wage_chf ?? 0);
    let personalKosten = 0;
    if (brutto > 0) {
      const pctSet: LohnPctSet = effectivePcts(comp as PctComp, lohnDefaults);
      const employerPctSum = sumEmployerPct(pctSet);
      const hourlyVoll = brutto * (1 + employerPctSum / 100);
      personalKosten = (hourlyVoll * mins) / 60;
    }

    // In Job-Buckets aggregieren.
    jobMinutes.set(te.job_id, (jobMinutes.get(te.job_id) ?? 0) + mins);
    jobPersonalKosten.set(te.job_id, (jobPersonalKosten.get(te.job_id) ?? 0) + personalKosten);
    jobUmsatz.set(te.job_id, (jobUmsatz.get(te.job_id) ?? 0) + umsatz);

    // In Person-Buckets.
    personMinutes.set(te.user_id, (personMinutes.get(te.user_id) ?? 0) + mins);
    personKosten.set(te.user_id, (personKosten.get(te.user_id) ?? 0) + personalKosten);

    // In Tier-Buckets (nur wenn Tier existiert — sonst haetten wir keine Zuordnung).
    if (hasRateTiers && effTierId) {
      addToTier(effTierId, { minutes: mins, umsatz, personalKosten });
    }
  }

  // ------------------------------------------------------------------
  // People-Liste sortiert
  // ------------------------------------------------------------------
  const people: LocationReportPerson[] = userIds.map((uid) => {
    const profile = profileById.get(uid);
    const latestComp = comps
      .filter((c) => c.profile_id === uid)
      .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""))[0];
    const brutto = Number(latestComp?.hourly_wage_chf ?? 0);
    const pctSet = effectivePcts(latestComp as PctComp | undefined, lohnDefaults);
    const employerPctSum = sumEmployerPct(pctSet);
    const hourlyVoll = brutto > 0 ? brutto * (1 + employerPctSum / 100) : 0;
    return {
      id: uid,
      full_name: profile?.full_name ?? "Unbekannt",
      role: profile?.role ?? null,
      hourly_wage_chf: brutto || null,
      employer_pct_sum: employerPctSum,
      hourly_vollkosten_chf: hourlyVoll,
      minutes: personMinutes.get(uid) ?? 0,
      personal_vollkosten_chf: personKosten.get(uid) ?? 0,
    };
  }).sort((a, b) => b.minutes - a.minutes);

  // ------------------------------------------------------------------
  // Jobs-Liste mit Aggregaten. Kunden-Fallback: bei Partner-Anfragen
  // ist jobs.customer_id oft NULL — der Kunde steht dann nur an der
  // Location (location.customer). Wir zeigen den Location-Kunden als
  // Fallback, damit "—" nicht mehr faelschlich erscheint.
  // ------------------------------------------------------------------
  const locationCustomerName = (() => {
    const c = loc.customer as { name: string } | { name: string }[] | null;
    if (!c) return null;
    return Array.isArray(c) ? c[0]?.name ?? null : c.name;
  })();
  const jobs: LocationReportJob[] = rawJobs.map((j) => {
    const cust = Array.isArray(j.customer) ? j.customer[0] : j.customer;
    const kosten = jobPersonalKosten.get(j.id) ?? 0;
    const ums = hasRateTiers ? (jobUmsatz.get(j.id) ?? 0) : null;
    return {
      id: j.id,
      job_number: j.job_number,
      title: j.title,
      status: j.status,
      start_date: j.start_date,
      end_date: j.end_date,
      customer_name: cust?.name ?? locationCustomerName,
      minutes: jobMinutes.get(j.id) ?? 0,
      personal_vollkosten_chf: kosten,
      umsatz_chf: ums,
      marge_chf: ums !== null ? ums - kosten : null,
      invoiced_at: j.invoiced_at,
    };
  });

  // ------------------------------------------------------------------
  // KPIs
  // ------------------------------------------------------------------
  const totalMinutes = Array.from(personMinutes.values()).reduce((s, v) => s + v, 0);
  const totalPersonalVollkosten = Array.from(personKosten.values()).reduce((s, v) => s + v, 0);
  const totalUmsatz = hasRateTiers
    ? Array.from(jobUmsatz.values()).reduce((s, v) => s + v, 0)
    : null;
  const teamSize = userIds.length + partnerUsers.length;
  const kpis: LocationReportKpis = {
    total_jobs: jobs.length,
    jobs_completed: jobs.filter((j) => j.status === "abgeschlossen").length,
    jobs_cancelled: jobs.filter((j) => j.status === "storniert").length,
    jobs_planned_future: jobs.filter((j) => toZurichDate(j.start_date) > today && j.status !== "storniert").length,
    total_minutes: totalMinutes,
    personal_vollkosten_chf: totalPersonalVollkosten,
    team_size: teamSize,
    umsatz_chf: totalUmsatz,
    marge_chf: totalUmsatz !== null ? totalUmsatz - totalPersonalVollkosten : null,
  };

  // ------------------------------------------------------------------
  // Tier-Aufschluesselung
  // ------------------------------------------------------------------
  const tierBreakdown: LocationReportTierBreakdown[] = activeTiers
    .map((t) => {
      const agg = tierAggByTierId.get(t.id) ?? { minutes: 0, umsatz: 0, personalKosten: 0 };
      return {
        tier_id: t.id,
        key: t.key,
        label: t.label,
        minutes: agg.minutes,
        umsatz_chf: agg.umsatz,
        personal_vollkosten_chf: agg.personalKosten,
        marge_chf: agg.umsatz - agg.personalKosten,
      };
    })
    .sort((a, b) => b.minutes - a.minutes);

  // ------------------------------------------------------------------
  // Pipeline
  // ------------------------------------------------------------------
  const pipeline: LocationReportPipelineItem[] = [];
  for (const j of jobs) {
    if (toZurichDate(j.start_date) > today && j.status !== "storniert") {
      pipeline.push({
        kind: "job",
        id: j.id,
        title: `${j.title} — ${j.customer_name ?? "?"}`,
        date: j.start_date,
        extra: `Status: ${j.status}`,
      });
    }
  }
  for (const r of rentals) {
    pipeline.push({
      kind: "rental",
      id: r.id,
      title: r.title ?? "Mietanfrage",
      date: r.event_date,
      extra: r.status ?? null,
    });
  }
  for (const e of events) {
    pipeline.push({
      kind: "event",
      id: e.id,
      title: e.title,
      date: e.start_date,
      extra: null,
    });
  }
  pipeline.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  // ------------------------------------------------------------------
  // Monatsverlauf (24m Historie)
  // ------------------------------------------------------------------
  const monthMap = new Map<string, { minutes: number; jobs: Set<string> }>();
  for (const te of allEntries) {
    if (!te.job_id) continue;
    const mins = minutesBetween(te.clock_in, te.clock_out);
    if (mins <= 0) continue;
    const ym = fmtYm(te.clock_in);
    const cell = monthMap.get(ym) ?? { minutes: 0, jobs: new Set<string>() };
    cell.minutes += mins;
    cell.jobs.add(te.job_id);
    monthMap.set(ym, cell);
  }
  for (const j of jobs) {
    if (!j.start_date) continue;
    const ym = fmtYm(j.start_date);
    const cell = monthMap.get(ym) ?? { minutes: 0, jobs: new Set<string>() };
    cell.jobs.add(j.id);
    monthMap.set(ym, cell);
  }
  const months: LocationReportMonth[] = Array.from(monthMap.entries())
    .map(([ym, v]) => ({ ym, minutes: v.minutes, jobs: v.jobs.size }))
    .sort((a, b) => a.ym.localeCompare(b.ym));

  return {
    location: {
      id: loc.id,
      name: loc.name,
      address_street: loc.address_street ?? null,
      address_zip: loc.address_zip ?? null,
      address_city: loc.address_city ?? null,
      capacity: loc.capacity ?? null,
      notes: loc.notes ?? null,
      technical_details: loc.technical_details ?? null,
      default_hourly_rate_chf: loc.default_hourly_rate_chf ?? null,
      customer_name: (() => {
        const c = loc.customer as { name: string } | { name: string }[] | null;
        if (!c) return null;
        return Array.isArray(c) ? c[0]?.name ?? null : c.name;
      })(),
      has_rate_tiers: hasRateTiers,
    },
    period: { from, to, today },
    kpis,
    jobs,
    people,
    contacts,
    partner_users: partnerUsers,
    pipeline,
    months,
    tier_breakdown: tierBreakdown,
  };
}
