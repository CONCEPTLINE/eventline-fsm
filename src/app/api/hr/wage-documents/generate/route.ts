// POST /api/hr/wage-documents/generate
// Body: { profile_id, year, month }
//
// Generiert eine PDF-Lohnabrechnung fuer den Mitarbeiter+Monat aus den
// Daten der Monatsstats (gleiche Berechnung wie die Tabelle: Stempel/
// Geplant/Rapport-Stunden, Lohn/h, Brutto inkl. Zuschlag, Abzuege,
// Netto/Auszahlung), uploaded sie in den Storage und legt eine
// wage_documents-Row an. So muss Admin nicht extern PDFs erstellen.
//
// Inhalt-Layout der PDF (per Art. 323b OR Pflichtinhalt):
//   - Firmen-Header (EVENTLINE)
//   - Mitarbeiter-Name + -Adresse (placeholder)
//   - Abrechnungszeitraum (Monat / Jahr)
//   - Stunden-Aufschluesselung
//   - Brutto-Lohn mit Zuschlag-Breakdown
//   - Mitarbeiter-Abzuege im Detail (AHV/ALV/NBU/BVG/KTG/QST)
//   - Netto-Auszahlung
//   - Hinweis dass das eine interne Berechnung ist, kein Lohnausweis
//
// Admin-only via requireAdmin.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { jsPDF } from "jspdf";
import { swissHolidaysForYear } from "@/lib/swiss-holidays";

const BUCKET = "lohndokumente";
const ZRH_TZ = "Europe/Zurich";

const CHF = (n: number) => new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function localDateIso(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZRH_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function localHour(d: Date) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: ZRH_TZ, hour: "2-digit", hour12: false }).format(d).split(":")[0]);
}
function localWeekday(d: Date) {
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[new Intl.DateTimeFormat("en-US", { timeZone: ZRH_TZ, weekday: "short" }).format(d)] ?? 0;
}
function fmtHours(min: number) {
  if (min === 0) return "0:00 h";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}:${String(m).padStart(2, "0")} h`;
}

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Body fehlt" }, { status: 400 });
  const profileId = String(body.profile_id ?? "");
  const year = Number(body.year);
  const month = Number(body.month);
  if (!profileId) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return NextResponse.json({ success: false, error: "year ungueltig" }, { status: 400 });
  if (!Number.isInteger(month) || month < 1 || month > 12) return NextResponse.json({ success: false, error: "month ungueltig" }, { status: 400 });

  const admin = createAdminClient();

  // Mitarbeiter + Compensation laden
  const { data: profile } = await admin.from("profiles").select("id, full_name, role, email").eq("id", profileId).single();
  if (!profile) return NextResponse.json({ success: false, error: "Mitarbeiter nicht gefunden" }, { status: 404 });

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;

  const { data: comp } = await admin
    .from("employee_compensation")
    .select("hourly_wage_chf, employer_costs_chf_per_hour, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, effective_from")
    .eq("profile_id", profileId)
    .lte("effective_from", monthStart)
    .or(`effective_to.is.null,effective_to.gte.${monthStart}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!comp) return NextResponse.json({ success: false, error: "Kein Lohn fuer diesen Monat hinterlegt" }, { status: 400 });

  // Stempel-Minuten (RPC der Monatstats hat das schon, aber wir koennen
  // direkt rechnen — vermeidet einen weiteren Hop)
  const { data: stempelEntries } = await admin
    .from("time_entries")
    .select("clock_in, clock_out")
    .eq("user_id", profileId)
    .gte("clock_in", monthStart)
    .lt("clock_in", monthEnd)
    .not("clock_out", "is", null);
  let stempelMin = 0;
  for (const e of (stempelEntries as { clock_in: string; clock_out: string }[] | null) ?? []) {
    stempelMin += Math.floor((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000);
  }

  // Geplant
  const { data: appts } = await admin
    .from("job_appointments")
    .select("start_time, end_time")
    .eq("assigned_to", profileId)
    .gte("start_time", monthStart)
    .lt("start_time", monthEnd);
  let geplantMin = 0;
  for (const a of (appts as { start_time: string; end_time: string }[] | null) ?? []) {
    geplantMin += Math.max(0, Math.floor((new Date(a.end_time).getTime() - new Date(a.start_time).getTime()) / 60000));
  }

  // Rapport-Stunden via RPC (gleiche Logik wie monthly-stats)
  const { data: rpcRows } = await admin.rpc("get_monthly_payroll_stats", { p_month_start: monthStart });
  type RpcRow = { profile_id: string; rapport_minutes: number };
  const rapportMin = (rpcRows as RpcRow[] | null)?.find((r) => r.profile_id === profileId)?.rapport_minutes ?? 0;

  // Surcharges berechnen (gleiche Logik wie monthly-stats — fetch YTD entries)
  const { data: yearEntries } = await admin
    .from("time_entries")
    .select("clock_in, clock_out")
    .eq("user_id", profileId)
    .gte("clock_in", `${year}-01-01T00:00:00+01:00`)
    .lt("clock_in", `${year + 1}-01-01T00:00:00+01:00`)
    .not("clock_out", "is", null);

  const holidays = swissHolidaysForYear(year);
  const holidaySet = new Set(holidays.map((h) => h.date));
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}-`;
  const yearPrefix = `${year}-`;

  interface DayBucket { date: string; total_minutes: number; night_minutes: number; is_sunhol: boolean; in_current_month: boolean; }
  const buckets = new Map<string, DayBucket>();
  for (const e of (yearEntries as { clock_in: string; clock_out: string }[] | null) ?? []) {
    const start = new Date(e.clock_in).getTime();
    const end = new Date(e.clock_out).getTime();
    if (end <= start) continue;
    for (let t = start; t < end; t += 60_000) {
      const d = new Date(t);
      const dateIso = localDateIso(d);
      if (!dateIso.startsWith(yearPrefix)) continue;
      let b = buckets.get(dateIso);
      if (!b) {
        const [y, m, dd] = dateIso.split("-").map(Number);
        const noon = new Date(Date.UTC(y, m - 1, dd, 12, 0, 0));
        const wd = localWeekday(noon);
        b = { date: dateIso, total_minutes: 0, night_minutes: 0, is_sunhol: wd === 0 || holidaySet.has(dateIso), in_current_month: dateIso.startsWith(monthPrefix) };
        buckets.set(dateIso, b);
      }
      b.total_minutes++;
      const h = localHour(d);
      if (h >= 23 || h < 6) b.night_minutes++;
    }
  }

  const sortedDays = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  const nightDays = sortedDays.filter((d) => d.night_minutes > 0);
  const sunholDays = sortedDays.filter((d) => d.is_sunhol && d.total_minutes > 0);
  const ytdNightBefore = nightDays.filter((d) => !d.in_current_month && d.date < monthPrefix).length;
  const ytdSunholBefore = sunholDays.filter((d) => !d.in_current_month && d.date < monthPrefix).length;
  let nightEligibleMin = 0, nightRank = ytdNightBefore;
  for (const d of nightDays) if (d.in_current_month) { nightRank++; if (nightRank <= 24) nightEligibleMin += d.night_minutes; }
  let sunholEligibleMin = 0, sunholRank = ytdSunholBefore;
  for (const d of sunholDays) if (d.in_current_month) { sunholRank++; if (sunholRank <= 6) sunholEligibleMin += d.total_minutes; }

  const wage = Number(comp.hourly_wage_chf);
  const employer = Number(comp.employer_costs_chf_per_hour);
  const effectiveMin = rapportMin > 0 ? rapportMin : stempelMin;
  const hours = effectiveMin / 60;
  const baseLohn = hours * wage;
  const nightSurcharge = (nightEligibleMin / 60) * wage * 0.25;
  const sunholSurcharge = (sunholEligibleMin / 60) * wage * 0.5;
  const totalSurcharge = nightSurcharge + sunholSurcharge;
  const brutto = baseLohn + totalSurcharge;
  const deductions = {
    AHV_IV_EO: { pct: Number(comp.ahv_iv_eo_pct), amount: brutto * Number(comp.ahv_iv_eo_pct) / 100 },
    ALV: { pct: Number(comp.alv_pct), amount: brutto * Number(comp.alv_pct) / 100 },
    NBU: { pct: Number(comp.nbu_pct), amount: brutto * Number(comp.nbu_pct) / 100 },
    BVG: { pct: Number(comp.bvg_pct), amount: brutto * Number(comp.bvg_pct) / 100 },
    KTG: { pct: Number(comp.ktg_pct), amount: brutto * Number(comp.ktg_pct) / 100 },
    Quellensteuer: { pct: Number(comp.quellensteuer_pct), amount: brutto * Number(comp.quellensteuer_pct) / 100 },
  };
  const totalDeductionPct = Object.values(deductions).reduce((s, d) => s + d.pct, 0);
  const totalDeductionAmount = Object.values(deductions).reduce((s, d) => s + d.amount, 0);
  const netto = brutto - totalDeductionAmount;
  const vollkosten = hours * (wage + employer) + totalSurcharge;

  // PDF generieren
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = 18;
  const left = 20, right = 190, contentWidth = right - left;

  // Header
  doc.setFontSize(18); doc.setFont("helvetica", "bold");
  doc.text("EVENTLINE GmbH", left, y);
  y += 6;
  doc.setFontSize(9); doc.setFont("helvetica", "normal");
  doc.text("Dornacherstrasse 192 · 4053 Basel", left, y);
  y += 10;

  doc.setFontSize(14); doc.setFont("helvetica", "bold");
  doc.text("Lohnabrechnung", left, y);
  doc.setFontSize(10); doc.setFont("helvetica", "normal");
  doc.text(`${MONTH_NAMES[month - 1]} ${year}`, right, y, { align: "right" });
  y += 8;
  doc.setDrawColor(200); doc.line(left, y, right, y); y += 6;

  // Mitarbeiter
  doc.setFontSize(10); doc.setFont("helvetica", "bold");
  doc.text("Mitarbeiter", left, y);
  doc.setFont("helvetica", "normal");
  doc.text(profile.full_name, left + 35, y);
  y += 5;
  doc.text("Rolle", left, y); doc.text(profile.role ?? "—", left + 35, y);
  y += 5;
  doc.text("E-Mail", left, y); doc.text(profile.email ?? "—", left + 35, y);
  y += 8;
  doc.setDrawColor(200); doc.line(left, y, right, y); y += 6;

  // Stunden
  doc.setFont("helvetica", "bold"); doc.text("Stunden", left, y); y += 5;
  doc.setFont("helvetica", "normal");
  const rows: [string, string][] = [
    ["Gestempelt", fmtHours(stempelMin)],
    ["Geplant (Termine)", fmtHours(geplantMin)],
    ["Rapportiert (Basis Abrechnung)", fmtHours(rapportMin)],
  ];
  for (const [k, v] of rows) {
    doc.text(k, left, y); doc.text(v, right, y, { align: "right" }); y += 5;
  }
  y += 3;
  doc.setDrawColor(200); doc.line(left, y, right, y); y += 6;

  // Lohnberechnung
  doc.setFont("helvetica", "bold"); doc.text("Vergütung", left, y); y += 5;
  doc.setFont("helvetica", "normal");
  doc.text(`Stundenlohn (brutto)`, left, y); doc.text(`CHF ${CHF(wage)} / h`, right, y, { align: "right" }); y += 5;
  doc.text(`Basis-Lohn (${(effectiveMin / 60).toFixed(2)} h × CHF ${CHF(wage)})`, left, y); doc.text(`CHF ${CHF(baseLohn)}`, right, y, { align: "right" }); y += 5;
  if (nightEligibleMin > 0) {
    doc.text(`Nachtzuschlag 25% (${(nightEligibleMin / 60).toFixed(2)} h × CHF ${CHF(wage)} × 25%)`, left, y);
    doc.text(`+ CHF ${CHF(nightSurcharge)}`, right, y, { align: "right" }); y += 5;
  }
  if (sunholEligibleMin > 0) {
    doc.text(`Sonntags-/Feiertagszuschlag 50% (${(sunholEligibleMin / 60).toFixed(2)} h × CHF ${CHF(wage)} × 50%)`, left, y);
    doc.text(`+ CHF ${CHF(sunholSurcharge)}`, right, y, { align: "right" }); y += 5;
  }
  y += 2;
  doc.setFont("helvetica", "bold");
  doc.text("Bruttolohn", left, y); doc.text(`CHF ${CHF(brutto)}`, right, y, { align: "right" });
  y += 7;

  // Abzuege
  doc.setFont("helvetica", "bold"); doc.text("Abzüge Mitarbeiter", left, y); y += 5;
  doc.setFont("helvetica", "normal");
  for (const [k, d] of Object.entries(deductions)) {
    if (d.pct === 0) continue;
    doc.text(`${k} (${d.pct.toFixed(2)}%)`, left, y);
    doc.text(`− CHF ${CHF(d.amount)}`, right, y, { align: "right" });
    y += 5;
  }
  if (totalDeductionPct === 0) { doc.text("Keine Abzüge konfiguriert", left, y); y += 5; }
  y += 2;
  doc.setFont("helvetica", "bold");
  doc.text(`Total Abzüge (${totalDeductionPct.toFixed(2)}%)`, left, y); doc.text(`− CHF ${CHF(totalDeductionAmount)}`, right, y, { align: "right" });
  y += 8;
  doc.setDrawColor(80); doc.line(left, y, right, y); y += 7;

  // Netto / Auszahlung
  doc.setFontSize(13); doc.setFont("helvetica", "bold");
  doc.text("Auszahlung", left, y);
  doc.text(`CHF ${CHF(netto)}`, right, y, { align: "right" });
  y += 12;

  // Footer
  doc.setFontSize(8); doc.setFont("helvetica", "italic"); doc.setTextColor(120);
  const footerLines = [
    `Vollkosten Arbeitgeber: CHF ${CHF(vollkosten)} (inkl. Arbeitgeber-Anteil ${CHF(employer)}/h)`,
    "Diese Lohnabrechnung wird automatisch aus den im System erfassten Stunden + Lohndaten generiert.",
    "Der offizielle Lohnausweis (Formular 11) wird jährlich separat erstellt.",
    `Generiert am ${new Date().toLocaleDateString("de-CH")} um ${new Date().toLocaleTimeString("de-CH")}`,
  ];
  for (const line of footerLines) {
    doc.text(line, left, y, { maxWidth: contentWidth });
    y += 4;
  }

  // Upload + DB-Row
  const pdfArrayBuffer = doc.output("arraybuffer");
  const path = `${profileId}/${year}/lohnabrechnung_${year}-${String(month).padStart(2, "0")}.pdf`;
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, Buffer.from(pdfArrayBuffer), {
    contentType: "application/pdf",
    upsert: true,
  });
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 });

  // Upsert wage_documents
  const { data: existing } = await admin
    .from("wage_documents")
    .select("id")
    .eq("profile_id", profileId)
    .eq("doc_type", "lohnabrechnung")
    .eq("year", year)
    .eq("period_month", month)
    .maybeSingle();
  if (existing) {
    await admin
      .from("wage_documents")
      .update({ storage_path: path, file_size: pdfArrayBuffer.byteLength, uploaded_at: new Date().toISOString(), uploaded_by: auth.user.id })
      .eq("id", existing.id);
  } else {
    await admin.from("wage_documents").insert({
      profile_id: profileId,
      doc_type: "lohnabrechnung",
      year,
      period_month: month,
      storage_path: path,
      file_size: pdfArrayBuffer.byteLength,
      uploaded_by: auth.user.id,
    });
  }

  return NextResponse.json({ success: true, mode: existing ? "regenerated" : "generated" });
}
