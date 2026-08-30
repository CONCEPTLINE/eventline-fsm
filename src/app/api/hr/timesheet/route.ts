// GET /api/hr/timesheet?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Generiert ein Excel-Workbook (.xlsx) mit:
//   - Summary-Sheet: pro Mitarbeiter Total-Stunden + Brutto/Netto
//   - Pro aktiven Mitarbeiter ein eigenes Sheet mit Tag-fuer-Tag-
//     Aufschluesselung (Stempel/Geplant/Rapport-Minuten, Nacht-Min,
//     Sonntag/Feiertag-Flag, Surcharges, Brutto)
//
// Audit-tauglich: alle Zahlen kommen aus der gleichen Logik wie die
// Monats-Lohntabelle + PDF-Lohnabrechnung. Excel-Datei wird als
// Stream zurueckgegeben (Content-Disposition: attachment).
//
// Permission: lohn:manage + trusted device.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { swissHolidaysForYear } from "@/lib/swiss-holidays";
import { bucketizeMinutes, weekdayForDateIso, localDateIso, todayLocalIso, type MinuteBucket } from "@/lib/swiss-time";
import { loadLohnDefaults, effectivePcts, sumEmployeePct, sumEmployerPct, employerCostsPerHour } from "@/lib/employer-costs";
import { effectiveFerienanteil, splitBruttoFerien } from "@/lib/ferienanteil";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

interface DayBucket {
  date: string;
  total_minutes: number;
  night_minutes: number;
  is_sunhol: boolean;
  is_holiday: boolean;
  holiday_name: string | null;
}

interface EmpComp {
  profile_id: string;
  hourly_wage_chf: number | null;
  uses_standard_lohn: boolean | null;
  ferienanteil_pct_override: number | null;
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
  effective_from: string;
  effective_to: string | null;
}

interface ProfileRow {
  id: string;
  full_name: string;
  role: string;
  email: string;
  birthdate: string | null;
  is_active: boolean;
}

export async function GET(req: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ success: false, error: "from + to (YYYY-MM-DD) erforderlich" }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ success: false, error: "from muss <= to sein" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Profiles + alle Comp-Rows die in den Range fallen koennten.
  const [profilesRes, compsRes] = await Promise.all([
    admin.from("profiles").select("id, full_name, role, email, birthdate, is_active").neq("role", "partner").order("full_name"),
    admin.from("employee_compensation")
      .select("profile_id, hourly_wage_chf, uses_standard_lohn, ferienanteil_pct_override, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, effective_from, effective_to")
      .lte("effective_from", to)
      .or(`effective_to.is.null,effective_to.gte.${from}`),
  ]);
  if (profilesRes.error) return NextResponse.json({ success: false, error: profilesRes.error.message }, { status: 500 });
  if (compsRes.error) return NextResponse.json({ success: false, error: compsRes.error.message }, { status: 500 });

  const profiles = (profilesRes.data ?? []) as ProfileRow[];
  const profileIds = profiles.map((p) => p.id);

  // Time-Entries fuer alle MAs in der Range (mit Puffer fuer Cross-Day-Schichten).
  const fetchStartIso = new Date(`${from}T00:00:00Z`);
  fetchStartIso.setUTCDate(fetchStartIso.getUTCDate() - 1);
  const fetchEndIso = new Date(`${to}T23:59:59Z`);
  fetchEndIso.setUTCDate(fetchEndIso.getUTCDate() + 2);

  const { data: entries } = await admin
    .from("time_entries")
    .select("user_id, clock_in, clock_out")
    .in("user_id", profileIds)
    .gte("clock_in", fetchStartIso.toISOString())
    .lt("clock_in", fetchEndIso.toISOString())
    .not("clock_out", "is", null);

  // Geplant pro MA aus job_appointments.
  const { data: appts } = await admin
    .from("job_appointments")
    .select("assigned_to, start_time, end_time")
    .in("assigned_to", profileIds)
    .gte("start_time", `${from}T00:00:00Z`)
    .lt("start_time", `${to}T23:59:59Z`)
    .not("assigned_to", "is", null);

  // Rapport (service_reports). Mitternacht-Fix wie im RPC.
  const { data: reports } = await admin
    .from("service_reports")
    .select("report_date, time_ranges, status")
    .gte("report_date", from)
    .lte("report_date", to)
    .eq("status", "abgeschlossen");

  // Per-Year-Holidays sammeln.
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  const holidayMap = new Map<string, string>(); // date -> name
  for (let y = fromYear; y <= toYear; y++) {
    for (const h of swissHolidaysForYear(y)) holidayMap.set(h.date, h.name);
  }

  // Per-Profile Buckets aufbauen.
  type EntryRow = { user_id: string; clock_in: string; clock_out: string };
  const perProfileDays = new Map<string, Map<string, DayBucket>>();
  for (const e of (entries as EntryRow[] | null) ?? []) {
    let byDate = perProfileDays.get(e.user_id);
    if (!byDate) { byDate = new Map(); perProfileDays.set(e.user_id, byDate); }
    const tmp = new Map<string, MinuteBucket>();
    bucketizeMinutes(new Date(e.clock_in).getTime(), new Date(e.clock_out).getTime(), tmp);
    for (const r of tmp.values()) {
      if (r.date < from || r.date > to) continue;
      let b = byDate.get(r.date);
      if (!b) {
        const wd = weekdayForDateIso(r.date);
        const isHoliday = holidayMap.has(r.date);
        b = {
          date: r.date,
          total_minutes: 0,
          night_minutes: 0,
          is_sunhol: wd === 0 || isHoliday,
          is_holiday: isHoliday,
          holiday_name: isHoliday ? holidayMap.get(r.date) ?? null : null,
        };
        byDate.set(r.date, b);
      }
      b.total_minutes += r.total_minutes;
      b.night_minutes += r.night_minutes;
    }
  }

  // Geplant-Minuten pro (profile, date) sammeln.
  type ApptRow = { assigned_to: string; start_time: string; end_time: string | null };
  const geplantByProfileDate = new Map<string, Map<string, number>>();
  for (const a of (appts as ApptRow[] | null) ?? []) {
    if (!a.end_time) continue;
    const date = localDateIso(new Date(a.start_time));
    const min = Math.max(0, Math.floor((new Date(a.end_time).getTime() - new Date(a.start_time).getTime()) / 60000));
    let byDate = geplantByProfileDate.get(a.assigned_to);
    if (!byDate) { byDate = new Map(); geplantByProfileDate.set(a.assigned_to, byDate); }
    byDate.set(date, (byDate.get(date) ?? 0) + min);
  }

  // Rapport-Minuten pro (profile, date) aus service_reports.time_ranges.
  type RangeRow = { technician_id?: string; start?: string; end?: string; pause?: string };
  type ReportRow = { report_date: string; time_ranges: RangeRow[] | null };
  const rapportByProfileDate = new Map<string, Map<string, number>>();
  for (const r of (reports as ReportRow[] | null) ?? []) {
    const ranges = r.time_ranges ?? [];
    for (const rg of ranges) {
      if (!rg.technician_id || !rg.start || !rg.end) continue;
      const [sh, sm] = rg.start.split(":").map(Number);
      const [eh, em] = rg.end.split(":").map(Number);
      let mins = (eh * 60 + em) - (sh * 60 + sm);
      // Cross-midnight (z.B. 22:00 -> 02:00)
      if (mins < 0) mins += 24 * 60;
      mins -= rg.pause ? Number(rg.pause) || 0 : 0;
      if (mins <= 0) continue;
      let byDate = rapportByProfileDate.get(rg.technician_id);
      if (!byDate) { byDate = new Map(); rapportByProfileDate.set(rg.technician_id, byDate); }
      byDate.set(r.report_date, (byDate.get(r.report_date) ?? 0) + mins);
    }
  }

  // Latest Comp pro Profile (im Range gueltig).
  const compsByProfile = new Map<string, EmpComp>();
  for (const c of (compsRes.data ?? []) as EmpComp[]) {
    const existing = compsByProfile.get(c.profile_id);
    if (!existing || c.effective_from > existing.effective_from) compsByProfile.set(c.profile_id, c);
  }

  // asOf=Periodenstart: bei einem Range-Export (from-to) wollen wir die
  // zum Periodenbeginn gueltigen Firmen-Defaults. Historisierung Migration 195.
  const defaults = await loadLohnDefaults(admin, from);

  // Excel-Workbook bauen
  const wb = new ExcelJS.Workbook();
  wb.creator = "EVENTLINE FSM";
  wb.created = new Date(`${to}T12:00:00Z`); // deterministisch

  // Logo einmalig in's Workbook laden — wir nutzen die ImageId in jedem Sheet.
  let logoImageId: number | null = null;
  try {
    const logoPath = path.join(process.cwd(), "public", "logo-gmbh-black.png");
    const logoBuf = await fs.promises.readFile(logoPath);
    // exceljs erwartet Uint8Array/ArrayBuffer — Cast vom Node-Buffer.
    logoImageId = wb.addImage({ buffer: new Uint8Array(logoBuf).buffer, extension: "png" });
  } catch {
    // Fail-soft
  }

  // Logo als floatendes Bild oben rechts pro Sheet — sheet.columns +
  // direkter Overlay funktioniert in Excel sauber (Bild ist eine separate
  // Object-Schicht, ueberlappt die Cells nicht logisch).
  function placeLogo(sheet: ExcelJS.Worksheet, rightColIdx: number) {
    if (logoImageId == null) return;
    sheet.addImage(logoImageId, {
      tl: { col: rightColIdx - 2, row: 0 },
      ext: { width: 130, height: 30 },
    });
    sheet.getRow(1).height = 24;
  }

  const summarySheet = wb.addWorksheet("Übersicht");
  summarySheet.columns = [
    { header: "Mitarbeiter", key: "name", width: 26 },
    { header: "Rolle", key: "role", width: 14 },
    { header: "Stempel h", key: "stempel", width: 11 },
    { header: "Geplant h", key: "geplant", width: 11 },
    { header: "Rapport h", key: "rapport", width: 11 },
    { header: "Nacht h", key: "night", width: 9 },
    { header: "So/FT-Tage", key: "sunhol", width: 11 },
    { header: "Brutto CHF", key: "brutto", width: 13 },
    { header: "Netto CHF", key: "netto", width: 13 },
    { header: "Vollkosten CHF", key: "vollkosten", width: 14 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } };
  placeLogo(summarySheet, 10);

  for (const p of profiles) {
    const days = Array.from(perProfileDays.get(p.id)?.values() ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const geplantMap = geplantByProfileDate.get(p.id) ?? new Map<string, number>();
    const rapportMap = rapportByProfileDate.get(p.id) ?? new Map<string, number>();
    const comp = compsByProfile.get(p.id);

    let totalStempel = 0;
    let totalNight = 0;
    let totalGeplant = 0;
    let totalRapport = 0;
    let sunholDays = 0;

    // Mitarbeiter-Sheet (max 31 Char sheet name, sanitized).
    const sheetName = p.full_name.replace(/[\\/?*:[\]]/g, "_").slice(0, 31) || `User-${p.id.slice(0, 8)}`;
    const sheet = wb.addWorksheet(sheetName);
    sheet.columns = [
      { header: "Datum", key: "date", width: 12 },
      { header: "Wochentag", key: "wd", width: 11 },
      { header: "Sonn/Feier", key: "sunhol", width: 11 },
      { header: "Stempel-Min", key: "stempel_min", width: 12 },
      { header: "Nacht-Min", key: "night_min", width: 11 },
      { header: "Geplant-Min", key: "geplant_min", width: 12 },
      { header: "Rapport-Min", key: "rapport_min", width: 12 },
      { header: "Stempel h", key: "stempel_h", width: 10 },
      { header: "Notiz", key: "note", width: 22 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } };
    placeLogo(sheet, 9);

    // Alle Datums-Keys (Stempel + Geplant + Rapport union) damit der Sheet
    // auch Tage zeigt die nur geplant aber nicht gestempelt waren.
    const allDates = new Set<string>();
    for (const d of days) allDates.add(d.date);
    for (const d of geplantMap.keys()) allDates.add(d);
    for (const d of rapportMap.keys()) allDates.add(d);

    const sortedDates = Array.from(allDates).sort();
    const WEEKDAY_LABELS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
    for (const date of sortedDates) {
      const wd = weekdayForDateIso(date);
      const dayBucket = days.find((d) => d.date === date);
      const isHoliday = holidayMap.has(date);
      const isSunday = wd === 0;
      const isSunhol = isSunday || isHoliday;
      const stempel = dayBucket?.total_minutes ?? 0;
      const night = dayBucket?.night_minutes ?? 0;
      const geplant = geplantMap.get(date) ?? 0;
      const rapport = rapportMap.get(date) ?? 0;
      const note = isHoliday ? `Feiertag: ${holidayMap.get(date) ?? ""}` : isSunday ? "Sonntag" : "";

      sheet.addRow({
        date,
        wd: WEEKDAY_LABELS[wd],
        sunhol: isSunhol ? "JA" : "",
        stempel_min: stempel,
        night_min: night,
        geplant_min: geplant,
        rapport_min: rapport,
        stempel_h: stempel > 0 ? Number((stempel / 60).toFixed(2)) : 0,
        note,
      });

      totalStempel += stempel;
      totalNight += night;
      totalGeplant += geplant;
      totalRapport += rapport;
      if (isSunhol && stempel > 0) sunholDays++;
    }

    // Totals-Zeile pro MA-Sheet
    const totalsRow = sheet.addRow({
      date: "TOTAL",
      wd: "",
      sunhol: "",
      stempel_min: totalStempel,
      night_min: totalNight,
      geplant_min: totalGeplant,
      rapport_min: totalRapport,
      stempel_h: Number((totalStempel / 60).toFixed(2)),
      note: "",
    });
    totalsRow.font = { bold: true };
    totalsRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F6F6" } };

    // Surcharges + Brutto fuer Summary-Zeile
    const wage = comp?.hourly_wage_chf != null ? Number(comp.hourly_wage_chf) : 0;
    const effectiveMin = totalRapport > 0 ? totalRapport : totalStempel;
    let brutto = 0;
    let netto = 0;
    let vollkosten = 0;
    if (wage > 0 && effectiveMin > 0) {
      const hours = effectiveMin / 60;
      const baseLohn = hours * wage;
      // Surcharges hier vereinfacht: alle Nacht-Min × 25%, alle So/FT × 50%
      // (kein YTD-Limit-Check fuer den Zeitraum-Export — fuer Audit ist's
      // ueblich die theoretischen Maxima zu zeigen. Hinweis im Sheet).
      const nightSurcharge = (totalNight / 60) * wage * 0.25;
      let sunholMinutes = 0;
      for (const d of days) if (d.is_sunhol) sunholMinutes += d.total_minutes;
      const sunholSurcharge = (sunholMinutes / 60) * wage * 0.5;
      brutto = baseLohn + nightSurcharge + sunholSurcharge;
      const pcts = effectivePcts(comp ?? null, defaults);
      const totalDed = sumEmployeePct(pcts);
      netto = brutto * (1 - totalDed / 100);
      const employer = employerCostsPerHour(wage, sumEmployerPct(pcts));
      vollkosten = hours * (wage + employer) + nightSurcharge + sunholSurcharge;
    }

    // Lohn-Block ans MA-Sheet anhaengen
    sheet.addRow({});
    const lohnHeader = sheet.addRow({ date: "LOHN-AUFSCHLÜSSELUNG", wd: "", sunhol: "", stempel_min: "", night_min: "", geplant_min: "", rapport_min: "", stempel_h: "", note: "" });
    lohnHeader.font = { bold: true };
    sheet.addRow({ date: "Brutto-Stundenlohn", note: wage > 0 ? `CHF ${wage.toFixed(2)} / h` : "—" });
    if (comp && p.birthdate) {
      const periodMid = `${from.slice(0, 4)}-${from.slice(5, 7)}-15`;
      const ferienPct = effectiveFerienanteil(comp.ferienanteil_pct_override, p.birthdate, periodMid);
      const split = splitBruttoFerien(wage, ferienPct);
      sheet.addRow({ date: `  davon Ferienanteil ${ferienPct.toFixed(2)}%`, note: `CHF ${split.ferienanteil.toFixed(2)} / h` });
      sheet.addRow({ date: "  davon Grundlohn", note: `CHF ${split.grundlohn.toFixed(2)} / h` });
    }
    sheet.addRow({ date: "Effektive Minuten (Basis)", note: effectiveMin });
    sheet.addRow({ date: "  davon Rapport", note: totalRapport });
    sheet.addRow({ date: "  davon Stempel (Fallback)", note: totalStempel });
    sheet.addRow({ date: "Brutto-Lohnkosten", note: `CHF ${brutto.toFixed(2)}` });
    sheet.addRow({ date: "Netto-Auszahlung", note: `CHF ${netto.toFixed(2)}` });
    sheet.addRow({ date: "Vollkosten Arbeitgeber", note: `CHF ${vollkosten.toFixed(2)}` });
    sheet.addRow({});
    const hinweisRow = sheet.addRow({ date: "Hinweis", note: "Surcharges hier ohne ArG-YTD-Limit (24 Nächte / 6 Sonntage) berechnet — Maxima für Audit. Effektive Lohnabrechnung kann niedriger sein." });
    hinweisRow.font = { italic: true, color: { argb: "FF888888" } };

    // Summary-Zeile
    summarySheet.addRow({
      name: p.full_name + (p.is_active ? "" : " (deaktiv)"),
      role: p.role,
      stempel: Number((totalStempel / 60).toFixed(2)),
      geplant: Number((totalGeplant / 60).toFixed(2)),
      rapport: Number((totalRapport / 60).toFixed(2)),
      night: Number((totalNight / 60).toFixed(2)),
      sunhol: sunholDays,
      brutto: Number(brutto.toFixed(2)),
      netto: Number(netto.toFixed(2)),
      vollkosten: Number(vollkosten.toFixed(2)),
    });
  }

  // Header-Info-Sheet
  const infoSheet = wb.addWorksheet("Info");
  infoSheet.columns = [{ key: "k", width: 18 }, { key: "v", width: 60 }];
  infoSheet.addRow({ k: "Zeitraum", v: `${from} bis ${to}` });
  infoSheet.addRow({ k: "Generiert", v: todayLocalIso() });
  infoSheet.addRow({ k: "Generiert von", v: auth.user.email ?? auth.user.id });
  infoSheet.addRow({ k: "Quelle", v: "EVENTLINE FSM — automatische Aggregation aus Stempel-, Termin- und Rapport-Daten" });
  infoSheet.addRow({ k: "", v: "" });
  infoSheet.addRow({ k: "Hinweis", v: "Pro Mitarbeiter eigenes Sheet mit Tag-für-Tag-Aufschlüsselung. Surcharges (25% Nacht / 50% So-FT) sind ohne ArG-YTD-Limits berechnet — für Audit-Zwecke die Maxima." });

  // Render zu Buffer
  const buffer = await wb.xlsx.writeBuffer();
  const filename = `eventline-timesheet_${from}_${to}.xlsx`;
  return new NextResponse(buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
