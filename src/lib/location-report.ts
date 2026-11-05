/**
 * Location-Report — Datenaggregation fuer den Rentabilitaets-Rapport
 * pro Standort. Server-seitig aufgerufen von /standorte/[id]/report.
 *
 * Grober Aufbau:
 *   - Location-Kopf + Kontakte + Partner-User
 *   - Jobs im Zeitraum (vergangenheit) — status/typ, Kunde, Stunden
 *   - Stunden pro Mitarbeiter (aggregiert)
 *   - Personalkosten = Σ (Stunden × Kosten-CHF/h am Stempel-Tag) je Mitarbeiter
 *     Kosten-CHF/h = kosten_chf_h aus Trust flow (personal_saetze, Lohn neu
 *     Phase 1b; src/lib/personal-saetze.ts) — gleiche Basis wie die
 *     Auftrags-Prognose (src/lib/job-costs.ts). Stunden ohne Satz fliessen
 *     nicht in die Kosten ein und werden je Person/KPI ausgewiesen.
 *   - Pipeline (zukunft): geplante Jobs, offene Rentals, Calendar-Events
 *   - Monatsverlauf (historie 24m): Umsatz-Info leer (Bexio), Stunden + Anzahl-Jobs
 *
 * Umsatz: bewusst NICHT enthalten — Rechnungssummen leben in Bexio, nicht
 * in unserer DB. Der Report zeigt die Kosten-Seite (Personal-Vollkosten
 * fuer den Arbeitgeber) und die Aktivitaets-Seite (Anzahl, Stunden, Team).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { ladeSatzVerlauf, satzAm } from "@/lib/personal-saetze";
import { localDateIso } from "@/lib/swiss-time";

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
  /** Personen mit Stunden im Zeitraum, fuer die (teilweise) kein
   *  Stundensatz vorliegt — deren Stunden ohne Satz sind NICHT in den Kosten. */
  personen_ohne_satz: number;
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
  /** Kosten-CHF/h am Ende des Zeitraums (hoechstens heute); null = kein Satz. */
  hourly_vollkosten_chf: number | null;
  minutes: number;
  /** Davon Minuten ohne Stundensatz (nicht in personal_vollkosten_chf). */
  minutes_ohne_satz: number;
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
  /** Zuerich-Tag YYYY-MM-DD, falls schon bekannt: Rapport-Zeiten (clock_in
   *  ist dort naive Lokalzeit, kein timestamptz) bringen ihr Datum mit. */
  date_iso?: string;
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

/** "YYYY-MM" aus einem Zuerich-Tag "YYYY-MM-DD" (nie aus einem timestamptz). */
function fmtYm(dateIso: string): string {
  return dateIso.slice(0, 7);
}

function minutesBetween(from: string, to: string | null): number {
  const end = to ?? new Date().toISOString();
  const ms = new Date(end).getTime() - new Date(from).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

/**
 * Zurich-Datum als "YYYY-MM-DD". CLAUDE.md §4: NIE toISOString().slice(0,10)
 * fuer Datums-Anzeigen/Vergleiche — das liefert UTC. Zwischen 00-02 CEST
 * ergibt UTC den Vortag → past/future-Klassifizierung wandert.
 */
function toZurichDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return localDateIso(new Date(iso));
}

/** Zuerich-Tag eines (echten oder aus dem Rapport synthetisierten) Eintrags. */
function entryDateIso(te: RawTimeEntry): string {
  return te.date_iso ?? toZurichDate(te.clock_in);
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
        date_iso: range.date,
      });
    }
  }
  const allEntries: RawTimeEntry[] = [...timeEntries, ...srAsEntries];

  // ------------------------------------------------------------------
  // Kosten-Stundensaetze (Trust flow) fuer alle beteiligten User. Bis
  // zum spaetesten Tag des Zeitraums laden (Satz fuer die Personen-Liste
  // am Zeitraum-Ende, hoechstens heute).
  // ------------------------------------------------------------------
  const userIds = Array.from(new Set(allEntries.map((t) => t.user_id)));
  const satzStichtag = to < today ? to : today;
  const satzBis = allEntries.reduce((m, te) => { const d = entryDateIso(te); return d > m ? d : m; }, satzStichtag);
  const [verlauf, profsRes] = await Promise.all([
    ladeSatzVerlauf(admin, userIds, "kosten", satzBis),
    userIds.length > 0
      ? admin.from("profiles").select("id, full_name, role").in("id", userIds)
      : Promise.resolve({ data: [] as RawProfile[] }),
  ]);
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
  const personMinutenOhneSatz = new Map<string, number>();
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
    // Zuerich-Tag des Einstempelns (time_entries.clock_in = timestamptz) —
    // massgebend fuer Tier-Preis und Stundensatz (beides date-Spalten).
    const dateIso = entryDateIso(te);

    // Tier + Preis picken. Fallback auf Default-Tier wenn te.rate_tier_id NULL.
    const effTierId = te.rate_tier_id ?? defaultTierId;
    let umsatz = 0;
    if (hasRateTiers && effTierId) {
      const price = pickTierPrice(tierPrices, effTierId, dateIso);
      if (price !== null) umsatz = (price * mins) / 60;
    }

    // Personalkosten: Kosten-Satz am Stempel-Tag. Ohne Satz → nicht in die
    // Kosten, aber als «ohne Satz» je Person gezaehlt (nie still 0 CHF).
    const satz = satzAm(verlauf, te.user_id, dateIso);
    const personalKosten = satz === null ? 0 : (satz * mins) / 60;
    if (satz === null) personMinutenOhneSatz.set(te.user_id, (personMinutenOhneSatz.get(te.user_id) ?? 0) + mins);

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
    return {
      id: uid,
      full_name: profile?.full_name ?? "Unbekannt",
      role: profile?.role ?? null,
      hourly_vollkosten_chf: satzAm(verlauf, uid, satzStichtag),
      minutes: personMinutes.get(uid) ?? 0,
      minutes_ohne_satz: personMinutenOhneSatz.get(uid) ?? 0,
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
    personen_ohne_satz: Array.from(personMinutenOhneSatz.values()).filter((m) => m > 0).length,
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
    const ym = fmtYm(entryDateIso(te));
    const cell = monthMap.get(ym) ?? { minutes: 0, jobs: new Set<string>() };
    cell.minutes += mins;
    cell.jobs.add(te.job_id);
    monthMap.set(ym, cell);
  }
  for (const j of jobs) {
    if (!j.start_date) continue;
    const ym = fmtYm(toZurichDate(j.start_date));
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
