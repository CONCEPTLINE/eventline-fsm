// GET /api/hr/monthly-stats?month=YYYY-MM
//
// Liefert pro Mitarbeiter die aggregierten Stunden + Kosten fuer
// den angegebenen Monat — INKLUSIVE Zuschlaegen fuer Nacht- und
// Sonntags-/Feiertagsarbeit gemaess Schweizer ArG:
//
//   - Nachtarbeit (23:00-06:00): erste 24 Einsaetze pro Kalenderjahr
//     bekommen 25% Lohnzuschlag (ArG Art. 17b). Ab Einsatz 25 nur noch
//     10% Zeitkompensation (= kein Geld → nicht in Lohnkosten).
//   - Sonntag/Feiertag-Arbeit: erste 6 Einsaetze (combined) pro Jahr
//     bekommen 50% Lohnzuschlag (ArGV 1 Art. 28). Ab 7. → Ersatzruhetage.
//
// Algorithmus:
//   1. RPC liefert basis-Stempel/Geplant/Rapport-Minuten + Comp-Daten
//   2. Zusaetzlich fetchen wir alle time_entries des Kalenderjahres
//   3. Pro Profile + Datum: ermitteln Nacht-Minuten und ob Sonntag/Feiertag
//   4. Per YTD-Reihenfolge: bestimmen ob diese Schicht noch im Limit liegt
//   5. Nur die zuschlags-berechtigten Stunden DIESES Monats kriegen Premium
//
// Permission: strikt admin-only (Trust-Device + role='admin' + RPC-Guard).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { swissHolidaysForYear } from "@/lib/swiss-holidays";
import { bucketizeMinutes, weekdayForDateIso, localDateIso, localHour, localWeekday, type MinuteBucket } from "@/lib/swiss-time";
import { loadLohnDefaults, effectivePcts, sumEmployerPct, sumEmployeePct, employerCostsPerHour } from "@/lib/employer-costs";
import { calculateForecast, monthRange } from "@/lib/bvg-forecast";

interface RpcRow {
  profile_id: string;
  full_name: string;
  role: string;
  is_active: boolean;
  stempel_minutes: number;
  geplant_minutes: number;
  rapport_minutes: number;
  hourly_wage_chf: number | null;
  uses_standard_lohn: boolean | null;
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

// Timezone-/Date-/Minute-Helper sind in @/lib/swiss-time zentralisiert.
// Hier nur DayBucket-Wrapper mit zusaetzlichen Flags.

interface DayBucket {
  date: string; // YYYY-MM-DD lokal
  total_minutes: number;
  night_minutes: number;
  is_sunhol: boolean;
  in_current_month: boolean;
}

interface SurchargeResult {
  night_surcharge_chf: number;
  sunhol_surcharge_chf: number;
  total_surcharge_chf: number;
  // Diagnostics fuers UI-Tooltip
  night_eligible_minutes: number;
  sunhol_eligible_minutes: number;
  ytd_night_shifts_before_month: number;
  ytd_sunhol_shifts_before_month: number;
  // Zeitkomp ab Nacht 25 (ArG 17b Abs. 3): 10% der Nacht-Minuten als Komp-Stunden
  // gutgeschrieben. Diesen Monat erworben + YTD-Total kumuliert.
  night_time_comp_minutes_this_month: number;
  ytd_night_time_comp_minutes: number;
  // Anzahl Nacht-Schichten diesen Monat ueber dem 24-Limit
  night_shifts_over_limit_this_month: number;
  ytd_night_shifts_total: number;
}

export async function GET(req: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;
  const adminClient = createAdminClient();
  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ success: false, error: "Nur für Administratoren" }, { status: 403 });
  }

  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ success: false, error: "Ungültiger Monat (erwartet YYYY-MM)" }, { status: 400 });
  }
  const monthStart = `${month}-01`;
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_monthly_payroll_stats", { p_month_start: monthStart });
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  // Alle Time-Entries die LOKAL irgendeinen Anteil im Kalenderjahr haben.
  // Filter ist clock_in zwischen [Vorjahres-Dez-30, Folgejahr-Jan-2] um
  // Schichten an Jahres-Wechseln (z.B. Silvester 22:00 - 1.1. 04:00)
  // korrekt zu erfassen — die Per-Minute-Attribution sortiert sie dann
  // anhand des lokalen Datums in den richtigen Day-Bucket. UTC-Cutoffs
  // mit grosszuegigem Puffer.
  // Fetch-Range mit Puffer fuer Schichten ueber Jahres-/Monats-Grenzen.
  // Eine Schicht 31.12. 22:00 → 1.1. 04:00 hat clock_in im Dezember-UTC,
  // ihre 1.1.-Minuten gehoeren ins Folgejahr. Wenn wir auf das Folgejahr
  // queryen, wuerde clock_in (Dezember-UTC) unter `gte year-start` fallen
  // → Entry verloren. Daher Puffer von 2 Tagen beidseitig.
  const profileIds = (data as RpcRow[]).map((r) => r.profile_id);
  const fetchStartIso = new Date(`${year - 1}-12-30T00:00:00Z`).toISOString();
  const fetchEndIso = new Date(`${year + 1}-01-02T00:00:00Z`).toISOString();
  const { data: entries } = await adminClient
    .from("time_entries")
    .select("user_id, clock_in, clock_out")
    .in("user_id", profileIds)
    .gte("clock_in", fetchStartIso)
    .lt("clock_in", fetchEndIso)
    .not("clock_out", "is", null);

  // Pro Profile + Datum aggregieren — per-Minute-Attribution (DST-safe).
  const holidays = swissHolidaysForYear(year);
  const holidaySet = new Set(holidays.map((h) => h.date));
  const monthPrefix = `${yearStr}-${monthStr.padStart(2, "0")}-`;
  const yearPrefix = `${yearStr}-`;

  type EntryRow = { user_id: string; clock_in: string; clock_out: string };
  const perProfileDays = new Map<string, Map<string, DayBucket>>();
  for (const e of (entries as EntryRow[] | null) ?? []) {
    let byDate = perProfileDays.get(e.user_id);
    if (!byDate) { byDate = new Map(); perProfileDays.set(e.user_id, byDate); }
    const rawDates = new Map<string, MinuteBucket>();
    bucketizeMinutes(new Date(e.clock_in).getTime(), new Date(e.clock_out).getTime(), rawDates);
    for (const r of rawDates.values()) {
      // Minuten ausserhalb des Ziel-Kalenderjahres ignorieren (sie
      // werden vom Folge-/Vorjahres-Call abgedeckt — dort wird der
      // Entry ueber das gepufferte Fetch-Range eingelesen).
      if (!r.date.startsWith(yearPrefix)) continue;
      let bucket = byDate.get(r.date);
      if (!bucket) {
        const wd = weekdayForDateIso(r.date);
        bucket = {
          date: r.date,
          total_minutes: 0,
          night_minutes: 0,
          is_sunhol: wd === 0 || holidaySet.has(r.date),
          in_current_month: r.date.startsWith(monthPrefix),
        };
        byDate.set(r.date, bucket);
      }
      bucket.total_minutes += r.total_minutes;
      bucket.night_minutes += r.night_minutes;
    }
  }

  // Stempel-Minuten DST-safe ueber den Per-Date-Buckets aufaddieren
  // (statt UTC-Delta clock_out - clock_in — dies waere am DST-Vorlauf
  // 1h zu viel, am Rueckschritt 1h zu wenig).
  const stempelMinutesByProfile = new Map<string, number>();
  for (const [profileId, days] of perProfileDays.entries()) {
    let sum = 0;
    for (const d of days.values()) if (d.in_current_month) sum += d.total_minutes;
    stempelMinutesByProfile.set(profileId, sum);
  }

  // Pro Mitarbeiter: Surcharge-Berechnung anhand seiner YTD-Tage. Sortiert
  // nach Datum gibt uns den Einsatz-Rang fuers Jahres-Limit (24 Naechte /
  // 6 Sonntage+Feiertage).
  function computeSurcharges(buckets: DayBucket[], hourlyWage: number): SurchargeResult {
    const sorted = [...buckets].sort((a, b) => a.date.localeCompare(b.date));
    const nightDays = sorted.filter((d) => d.night_minutes > 0);
    const sunholDays = sorted.filter((d) => d.is_sunhol && d.total_minutes > 0);

    const ytdNightBefore = nightDays.filter((d) => !d.in_current_month && d.date < monthPrefix).length;
    const ytdSunholBefore = sunholDays.filter((d) => !d.in_current_month && d.date < monthPrefix).length;

    // Diesen-Monat-Zaehler: erforderlich fuer Zeitkomp-Tracking ab Nacht 25.
    let nightEligibleMin = 0;
    let nightOverLimitMinThisMonth = 0;
    let nightShiftsOverLimitThisMonth = 0;
    let nightRank = ytdNightBefore;
    for (const d of nightDays) {
      if (d.in_current_month) {
        nightRank++;
        if (nightRank <= 24) {
          nightEligibleMin += d.night_minutes;
        } else {
          // Ab Nacht 25: keine 25%-Geldzulage mehr, dafuer 10% Zeitkomp.
          nightOverLimitMinThisMonth += d.night_minutes;
          nightShiftsOverLimitThisMonth++;
        }
      }
    }
    // Zeitkomp diesen Monat = 10% der Nacht-Minuten die ueber dem Limit lagen.
    const nightTimeCompThisMonth = nightOverLimitMinThisMonth * 0.10;

    // YTD-Total inkl. dieser Monats (fuer's UI: 'X Komp-Minuten ytd erworben').
    // Nutze die gleiche Rank-Logik aber ueber alle Tage des Jahres bis incl. current month.
    let ytdNightTimeComp = 0;
    let ytdNightShifts = 0;
    let rank = 0;
    for (const d of nightDays) {
      rank++;
      ytdNightShifts = rank;
      if (rank > 24) ytdNightTimeComp += d.night_minutes * 0.10;
    }

    let sunholEligibleMin = 0;
    let sunholRank = ytdSunholBefore;
    for (const d of sunholDays) {
      if (d.in_current_month) {
        sunholRank++;
        if (sunholRank <= 6) sunholEligibleMin += d.total_minutes;
      }
    }

    const nightSurcharge = (nightEligibleMin / 60) * hourlyWage * 0.25;
    const sunholSurcharge = (sunholEligibleMin / 60) * hourlyWage * 0.5;

    return {
      night_surcharge_chf: nightSurcharge,
      sunhol_surcharge_chf: sunholSurcharge,
      total_surcharge_chf: nightSurcharge + sunholSurcharge,
      night_eligible_minutes: nightEligibleMin,
      sunhol_eligible_minutes: sunholEligibleMin,
      ytd_night_shifts_before_month: ytdNightBefore,
      ytd_sunhol_shifts_before_month: ytdSunholBefore,
      night_time_comp_minutes_this_month: nightTimeCompThisMonth,
      ytd_night_time_comp_minutes: ytdNightTimeComp,
      night_shifts_over_limit_this_month: nightShiftsOverLimitThisMonth,
      ytd_night_shifts_total: ytdNightShifts,
    };
  }

  // Firmen-Standards fuer AG-Anteil + Abzuege — werden genutzt wenn der
  // per-Mitarbeiter-Override null ist (Migrationen 152-154).
  const defaults = await loadLohnDefaults(adminClient);

  // BVG-Eintrittsschwelle — fuer Inline-Warnung pro Zeile.
  // Default 1890 falls noch nie gesetzt (gleicher Default wie Migration 148).
  const { data: appSettings } = await adminClient
    .from("app_settings")
    .select("bvg_threshold_chf")
    .eq("id", 1)
    .maybeSingle();
  const bvgThresholdChf = Number(appSettings?.bvg_threshold_chf ?? 1890);

  // 3-Monats-BVG-Forecast: selected month + 2 forward. Holt alle geplanten
  // job_appointments fuer die Mitarbeiter im 3-Monats-Fenster.
  const monthNum = Number(monthStr);
  const m0 = monthRange(year, monthNum);
  const mNext1Year = monthNum === 12 ? year + 1 : year;
  const mNext1Month = monthNum === 12 ? 1 : monthNum + 1;
  const m1 = monthRange(mNext1Year, mNext1Month);
  const mNext2Year = mNext1Month === 12 ? mNext1Year + 1 : mNext1Year;
  const mNext2Month = mNext1Month === 12 ? 1 : mNext1Month + 1;
  const m2 = monthRange(mNext2Year, mNext2Month);
  const FORECAST_MONTHS = [m0, m1, m2];

  const { data: forecastAppts } = await adminClient
    .from("job_appointments")
    .select("assigned_to, start_time, end_time")
    .in("assigned_to", profileIds)
    .gte("start_time", `${m0.start}T00:00:00Z`)
    .lt("start_time", `${m2.end}T23:59:59Z`)
    .not("assigned_to", "is", null);
  type ApptRow = { assigned_to: string; start_time: string; end_time: string | null };
  const apptsByProfile = new Map<string, { start_time: string; end_time: string | null }[]>();
  for (const a of (forecastAppts as ApptRow[] | null) ?? []) {
    if (!apptsByProfile.has(a.assigned_to)) apptsByProfile.set(a.assigned_to, []);
    apptsByProfile.get(a.assigned_to)!.push({ start_time: a.start_time, end_time: a.end_time });
  }

  const employees = (data as RpcRow[]).map((r) => {
    // RPC liefert stempel_minutes als UTC-Delta-Summe — DST-broken. Wir
    // ueberschreiben mit der per-Minute-DST-safe-Berechnung.
    const stempelDstSafe = stempelMinutesByProfile.get(r.profile_id) ?? r.stempel_minutes;
    const effectiveMinutes = r.rapport_minutes > 0 ? r.rapport_minutes : stempelDstSafe;
    const hours = effectiveMinutes / 60;
    const wage = r.hourly_wage_chf != null ? Number(r.hourly_wage_chf) : null;
    // Effektive Pcts via Helper (uses_standard_lohn-Flag entscheidet
    // ob Defaults oder Overrides greifen, siehe Migration 156).
    const eff = effectivePcts(r, defaults);
    const employerPctSum = sumEmployerPct(eff);
    const employerPerHour = wage != null ? employerCostsPerHour(wage, employerPctSum) : 0;

    // Surcharges nur wenn Wage gesetzt UND in_current_month-Days vorhanden
    const buckets = Array.from(perProfileDays.get(r.profile_id)?.values() ?? []);
    const surcharges = (wage != null && buckets.length > 0)
      ? computeSurcharges(buckets, wage)
      : { night_surcharge_chf: 0, sunhol_surcharge_chf: 0, total_surcharge_chf: 0,
          night_eligible_minutes: 0, sunhol_eligible_minutes: 0,
          ytd_night_shifts_before_month: 0, ytd_sunhol_shifts_before_month: 0,
          night_time_comp_minutes_this_month: 0, ytd_night_time_comp_minutes: 0,
          night_shifts_over_limit_this_month: 0, ytd_night_shifts_total: 0 };

    const baseLohnkosten = wage != null ? hours * wage : null;
    const lohnkostenWithSurcharge = baseLohnkosten != null
      ? baseLohnkosten + surcharges.total_surcharge_chf
      : null;
    const vollkosten = wage != null
      ? hours * (wage + employerPerHour) + surcharges.total_surcharge_chf
      : null;
    // Mitarbeiter-Abzuege summieren aus den effektiven Pcts.
    const totalDeductionPct = sumEmployeePct(eff);
    const nettolohn = lohnkostenWithSurcharge != null
      ? lohnkostenWithSurcharge * (1 - totalDeductionPct / 100)
      : null;

    // 3-Monats-BVG-Forecast: brutto (inkl. Nacht/Sonntag-Zuschlaegen) aus
    // GEPLANTEN Terminen. YTD-Limits werden berueckichtigt (24/6) damit
    // der Forecast exakt der Lohnabrechnung entspricht.
    // YTD-Start fuer Forecast = aktueller Stand inkl. dieses Monats (also
    // alle bisherigen Nacht-/Sonntag-Tage YTD bis Monats-Ende selected).
    const myAppts = apptsByProfile.get(r.profile_id) ?? [];
    const myBuckets = Array.from(perProfileDays.get(r.profile_id)?.values() ?? []);
    const ytdNightSoFar = myBuckets.filter((b) => b.night_minutes > 0 && b.date <= m0.end).length;
    const ytdSunholSoFar = myBuckets.filter((b) => b.is_sunhol && b.total_minutes > 0 && b.date <= m0.end).length;
    let bvgForecast3Months: number[];
    if (wage == null) {
      bvgForecast3Months = [0, 0, 0];
    } else {
      bvgForecast3Months = [];
      // Cumulative-counter: nach Forecast-Monat 0 die geplanten Naechte/
      // Sonntage als 'gezaehlt' uebernehmen damit Monat 1 die laufende
      // Summe sieht. Gleiches fuer Monat 1 -> 2.
      let runningNight = ytdNightSoFar;
      let runningSunhol = ytdSunholSoFar;
      for (const m of FORECAST_MONTHS) {
        const f = calculateForecast(myAppts, wage, m.start, m.end, {
          ytdNightDaysBefore: runningNight,
          ytdSunholDaysBefore: runningSunhol,
        });
        bvgForecast3Months.push(f.total_chf);
        // Counter fuer naechsten Monat hochziehen — sowohl eligible als
        // auch over-limit Naechte/Sonntage zaehlen fuer's Limit.
        // Wir brauchen die Tage-Counts, nicht Minuten — naehern mit
        // 'Anzahl Tage mit Nacht-Minuten in diesem Monat' aus den
        // appointments.
        const datesNight = new Set<string>();
        const datesSunhol = new Set<string>();
        // Approximation: zaehle pro Termin den Start-Tag falls Nacht-/Sonntag.
        // ZWINGEND lokale (Europe/Zurich) Hour/Weekday verwenden, nicht UTC —
        // sonst ist die Zaehlung saisonal versetzt (Termin 22:00 ZRH waere
        // in UTC 20:00 = nicht Nacht, Sonntag 01:00 ZRH waere UTC Samstag).
        for (const a of myAppts) {
          if (!a.end_time) continue;
          const startDate = new Date(a.start_time);
          const sDate = localDateIso(startDate);
          if (sDate < m.start || sDate > m.end) continue;
          const sH = localHour(startDate);
          if (sH >= 23 || sH < 6) datesNight.add(sDate); // Nacht-Fenster 23-06 (ArG 17b)
          const wd = localWeekday(startDate);
          if (wd === 0) datesSunhol.add(sDate);
        }
        runningNight += datesNight.size;
        runningSunhol += datesSunhol.size;
      }
    }

    return {
      ...r,
      stempel_minutes: stempelDstSafe,
      hourly_wage_chf: wage,
      // Effektive Werte fuer's Frontend — kein eigenes Resolven noetig.
      uses_standard_lohn: r.uses_standard_lohn !== false,
      employer_pct: employerPctSum,
      employer_costs_chf_per_hour: employerPerHour,
      effective_basis: r.rapport_minutes > 0 ? "rapport" : "stempel",
      base_lohnkosten_chf: baseLohnkosten,
      lohnkosten_chf: lohnkostenWithSurcharge,
      vollkosten_chf: vollkosten,
      nettolohn_chf: nettolohn,
      total_deduction_pct: totalDeductionPct,
      night_surcharge_chf: surcharges.night_surcharge_chf,
      sunhol_surcharge_chf: surcharges.sunhol_surcharge_chf,
      total_surcharge_chf: surcharges.total_surcharge_chf,
      night_eligible_minutes: surcharges.night_eligible_minutes,
      sunhol_eligible_minutes: surcharges.sunhol_eligible_minutes,
      // 3-Monats-BVG-Forecast aus job_appointments (siehe oben).
      // Reihenfolge: selected month, +1, +2.
      bvg_forecast_3_months_chf: bvgForecast3Months,
      // Zeitkomp-Tracking (ArG 17b Abs. 3): ab Nacht 25 -> 10% Zeitkomp.
      night_time_comp_minutes_this_month: surcharges.night_time_comp_minutes_this_month,
      ytd_night_time_comp_minutes: surcharges.ytd_night_time_comp_minutes,
      night_shifts_over_limit_this_month: surcharges.night_shifts_over_limit_this_month,
      ytd_night_shifts_total: surcharges.ytd_night_shifts_total,
      // Hinweis-Flags fuers UI: wenn YTD-Limit ueberschritten wurde
      night_over_limit: surcharges.ytd_night_shifts_before_month >= 24,
      sunhol_over_limit: surcharges.ytd_sunhol_shifts_before_month >= 6,
    };
  });

  return NextResponse.json({
    success: true,
    month,
    employees,
    bvgThresholdChf,
    bvgForecastMonthLabels: FORECAST_MONTHS.map((m) => m.label),
  });
}
