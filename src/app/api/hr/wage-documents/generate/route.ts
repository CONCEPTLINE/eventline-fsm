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
import { loadLohnDefaults, effectivePcts, sumEmployerPct, sumEmployeePct, employerCostsPerHour } from "@/lib/employer-costs";
import { effectiveFerienanteil, splitBruttoFerien } from "@/lib/ferienanteil";
import { jsPDF } from "jspdf";
import { swissHolidaysForYear } from "@/lib/swiss-holidays";
import { localDateIso, localHour, weekdayForDateIso } from "@/lib/swiss-time";
import fs from "node:fs";
import nodePath from "node:path";

const BUCKET = "lohndokumente";

const CHF = (n: number) => new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

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
  const overwriteManual = body.overwrite_manual === true;
  if (!profileId) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return NextResponse.json({ success: false, error: "year ungueltig" }, { status: 400 });
  if (!Number.isInteger(month) || month < 1 || month > 12) return NextResponse.json({ success: false, error: "month ungueltig" }, { status: 400 });

  const admin = createAdminClient();

  // Mitarbeiter + Compensation laden
  const { data: profile } = await admin.from("profiles").select("id, full_name, role, email, birthdate").eq("id", profileId).single();
  if (!profile) return NextResponse.json({ success: false, error: "Mitarbeiter nicht gefunden" }, { status: 404 });

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;

  const { data: comp } = await admin
    .from("employee_compensation")
    .select("hourly_wage_chf, uses_standard_lohn, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, ferienanteil_pct_override, effective_from")
    .eq("profile_id", profileId)
    .lte("effective_from", monthStart)
    .or(`effective_to.is.null,effective_to.gte.${monthStart}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!comp) return NextResponse.json({ success: false, error: "Kein Lohn fuer diesen Monat hinterlegt" }, { status: 400 });

  // Existierende Row pruefen — wenn manuelle Upload existiert, ohne
  // overwrite_manual-Flag abbrechen (verhindert Datenverlust bei
  // versehentlichem Generate auf Bexio-PDF).
  const { data: existingDoc } = await admin
    .from("wage_documents")
    .select("id, source")
    .eq("profile_id", profileId)
    .eq("doc_type", "lohnabrechnung")
    .eq("year", year)
    .eq("period_month", month)
    .maybeSingle();
  if (existingDoc?.source === "manual" && !overwriteManual) {
    return NextResponse.json({
      success: false,
      error: "Es existiert bereits eine manuell hochgeladene Lohnabrechnung fuer diesen Monat. Bestaetigen mit overwrite_manual=true zum Ueberschreiben.",
      requires_confirm: "manual_overwrite",
    }, { status: 409 });
  }

  // Effektive Lohn-Defaults + Pcts via Helper (all-or-nothing via uses_standard_lohn).
  const lohnDefaults = await loadLohnDefaults(admin);
  const eff = effectivePcts(comp, lohnDefaults);
  const effAhv = eff.ahvIvEoPct;
  const effAlv = eff.alvPct;
  const effNbu = eff.nbuPct;
  const effBvg = eff.bvgPct;
  const effKtg = eff.ktgPct;
  const effQst = eff.quellensteuerPct;

  // Total-Deduction-Sanity-Check (>=100% wuerde negativen Netto erzeugen)
  const totalDeductionPct = sumEmployeePct(eff);
  if (totalDeductionPct >= 100) {
    return NextResponse.json({
      success: false,
      error: `Summe der Abzuege ist ${totalDeductionPct.toFixed(2)}% — muss < 100% sein. Bitte Lohn-Daten pruefen.`,
    }, { status: 400 });
  }

  // Time-Entries fetchen mit Year-Boundary-Puffer (Silvester-Schichten).
  // Per-Minute-Bucketing macht Stempel/Nacht/Surcharge DST-safe + Year-safe.
  const fetchStartIso = new Date(`${year - 1}-12-30T00:00:00Z`).toISOString();
  const fetchEndIso = new Date(`${year + 1}-01-02T00:00:00Z`).toISOString();
  const { data: yearEntries } = await admin
    .from("time_entries")
    .select("clock_in, clock_out")
    .eq("user_id", profileId)
    .gte("clock_in", fetchStartIso)
    .lt("clock_in", fetchEndIso)
    .not("clock_out", "is", null);

  // Geplant (auch mit Puffer — Termine im Monat-Bereich)
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

  // Rapport-Stunden: direkt aus service_reports.time_ranges aggregieren.
  // KRITISCH: get_monthly_payroll_stats darf NICHT vom AdminClient
  // (service_role) gerufen werden, weil die RPC intern is_admin() prueft
  // — und is_admin() checkt auth.uid(), das bei service_role NULL ist.
  // Die RPC rasised dann 'forbidden', der Error wurde silent geswallowt
  // und rapportMin fiel auf 0, was die PDF auf Stempel-Basis (statt
  // Rapport-Basis) rechnen liess — Differenz von 100+ CHF zur Tabelle.
  // Inline-Logik = exakt das CTE 'rapport' aus migration 157.
  const { data: rapportReports } = await admin
    .from("service_reports")
    .select("time_ranges")
    .gte("report_date", monthStart)
    .lt("report_date", monthEnd)
    .eq("status", "abgeschlossen");
  interface RapportRange { technician_id?: string; start?: string; end?: string; pause?: string | number }
  let rapportMin = 0;
  for (const r of (rapportReports as { time_ranges: RapportRange[] | null }[] | null) ?? []) {
    for (const range of r.time_ranges ?? []) {
      if (range.technician_id !== profileId) continue;
      if (!range.start || !range.end) continue;
      const [sh, sm] = range.start.split(":").map(Number);
      const [eh, em] = range.end.split(":").map(Number);
      let mins = (eh * 60 + em) - (sh * 60 + sm);
      if (mins < 0) mins += 1440; // overnight (z.B. 22:00 -> 02:00)
      const pause = range.pause ? Number(range.pause) : 0;
      mins -= Number.isFinite(pause) ? pause : 0;
      rapportMin += Math.max(0, mins);
    }
  }

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
        const wd = weekdayForDateIso(dateIso);
        b = { date: dateIso, total_minutes: 0, night_minutes: 0, is_sunhol: wd === 0 || holidaySet.has(dateIso), in_current_month: dateIso.startsWith(monthPrefix) };
        buckets.set(dateIso, b);
      }
      b.total_minutes++;
      const h = localHour(d);
      if (h >= 23 || h < 6) b.night_minutes++;
    }
  }

  // Stempel-Minuten DST-safe = Summe der Per-Minute-Buckets im aktuellen Monat
  let stempelMin = 0;
  for (const b of buckets.values()) if (b.in_current_month) stempelMin += b.total_minutes;

  const sortedDays = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  const nightDays = sortedDays.filter((d) => d.night_minutes > 0);
  const sunholDays = sortedDays.filter((d) => d.is_sunhol && d.total_minutes > 0);
  const ytdNightBefore = nightDays.filter((d) => !d.in_current_month && d.date < monthPrefix).length;
  const ytdSunholBefore = sunholDays.filter((d) => !d.in_current_month && d.date < monthPrefix).length;
  let nightEligibleMin = 0;
  let nightTimeCompMin = 0;        // 10% der Nacht-Minuten ueber Limit (ArG 17b Abs. 3)
  let nightShiftsOverLimit = 0;
  let nightRank = ytdNightBefore;
  for (const d of nightDays) if (d.in_current_month) {
    nightRank++;
    if (nightRank <= 24) nightEligibleMin += d.night_minutes;
    else { nightTimeCompMin += d.night_minutes * 0.10; nightShiftsOverLimit++; }
  }
  let sunholEligibleMin = 0, sunholRank = ytdSunholBefore;
  for (const d of sunholDays) if (d.in_current_month) { sunholRank++; if (sunholRank <= 6) sunholEligibleMin += d.total_minutes; }

  const wage = Number(comp.hourly_wage_chf);
  // AG-Anteil pro Stunde aus den 6 effektiven AG-Pcts.
  const employer = employerCostsPerHour(wage, sumEmployerPct(eff));
  const effectiveMin = rapportMin > 0 ? rapportMin : stempelMin;
  // 0-Stunden-Block — verhindert sinnlose CHF-0.00-PDFs in Mitarbeiter-Feed
  if (effectiveMin === 0) {
    return NextResponse.json({
      success: false,
      error: "Keine Stunden im Monat — Lohnabrechnung nicht generierbar.",
    }, { status: 400 });
  }
  const hours = effectiveMin / 60;
  // Ferienanteil-Logik (Art. 329a/d OR): der Brutto-Stundenlohn ist
  // inklusive Ferienanteil. Wir spalten ihn fuer die Lohnabrechnung
  // explizit auf -- 8.33% Erwachsene, 10.64% U20 (oder Override).
  const monthMidIso = `${year}-${String(month).padStart(2, "0")}-15`;
  const ferienPct = effectiveFerienanteil(comp.ferienanteil_pct_override, profile.birthdate, monthMidIso);
  const wageSplit = splitBruttoFerien(wage, ferienPct);
  const grundlohnHourly = wageSplit.grundlohn;
  const ferienHourly = wageSplit.ferienanteil;
  const baseGrundlohn = hours * grundlohnHourly;
  const baseFerien = hours * ferienHourly;
  const baseLohn = hours * wage; // = baseGrundlohn + baseFerien (mathematisch identisch)
  const nightSurcharge = (nightEligibleMin / 60) * wage * 0.25;
  const sunholSurcharge = (sunholEligibleMin / 60) * wage * 0.5;
  const totalSurcharge = nightSurcharge + sunholSurcharge;
  const brutto = baseLohn + totalSurcharge;
  const deductions = {
    AHV_IV_EO: { pct: effAhv, amount: brutto * effAhv / 100 },
    ALV: { pct: effAlv, amount: brutto * effAlv / 100 },
    NBU: { pct: effNbu, amount: brutto * effNbu / 100 },
    BVG: { pct: effBvg, amount: brutto * effBvg / 100 },
    KTG: { pct: effKtg, amount: brutto * effKtg / 100 },
    Quellensteuer: { pct: effQst, amount: brutto * effQst / 100 },
  };
  const totalDeductionAmount = Object.values(deductions).reduce((s, d) => s + d.amount, 0);
  const netto = brutto - totalDeductionAmount;
  const vollkosten = hours * (wage + employer) + totalSurcharge;

  // PDF generieren
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = 18;
  const left = 20, right = 190, contentWidth = right - left;

  // Logo oben rechts (logo-gmbh-black ist 800x185 -> Aspect 4.32:1)
  try {
    const logoPath = nodePath.join(process.cwd(), "public", "logo-gmbh-black.png");
    const logoBuf = await fs.promises.readFile(logoPath);
    const logoBase64 = `data:image/png;base64,${logoBuf.toString("base64")}`;
    const logoWidth = 45;
    const logoHeight = logoWidth / (800 / 185);
    doc.addImage(logoBase64, "PNG", right - logoWidth, y - 4, logoWidth, logoHeight);
  } catch {
    // Fail-soft — falls Logo nicht ladbar, ohne weiter
  }

  // Header — Firma-Name kommt aus dem Logo, hier nur die Adresse.
  doc.setFontSize(9); doc.setFont("helvetica", "normal");
  doc.text("Dornacherstrasse 192 · 4053 Basel", left, y + 6);
  y += 14;

  doc.setFontSize(14); doc.setFont("helvetica", "bold");
  doc.text("Lohnabrechnung", left, y);
  doc.setFontSize(10); doc.setFont("helvetica", "normal");
  doc.text(`${MONTH_NAMES[month - 1]} ${year}`, right, y, { align: "right" });
  y += 8;
  doc.setDrawColor(200); doc.line(left, y, right, y); y += 6;

  // Mitarbeiter — maxWidth verhindert Overflow bei langen Namen
  doc.setFontSize(10); doc.setFont("helvetica", "bold");
  doc.text("Mitarbeiter", left, y);
  doc.setFont("helvetica", "normal");
  doc.text(profile.full_name, left + 35, y, { maxWidth: contentWidth - 35 });
  y += 5;
  doc.text("Rolle", left, y); doc.text(profile.role ?? "—", left + 35, y, { maxWidth: contentWidth - 35 });
  y += 5;
  doc.text("E-Mail", left, y); doc.text(profile.email ?? "—", left + 35, y, { maxWidth: contentWidth - 35 });
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

  // Lohnberechnung mit Brutto-Aufspaltung (Grundlohn + Ferienanteil).
  doc.setFont("helvetica", "bold"); doc.text("Vergütung", left, y); y += 5;
  doc.setFont("helvetica", "normal");
  doc.text(`Stundenlohn (brutto, inkl. Ferienanteil)`, left, y); doc.text(`CHF ${CHF(wage)} / h`, right, y, { align: "right" }); y += 5;
  doc.setTextColor(110); doc.setFontSize(9);
  doc.text(`davon Grundlohn:`, left + 5, y); doc.text(`CHF ${CHF(grundlohnHourly)} / h`, right, y, { align: "right" }); y += 4;
  doc.text(`davon Ferienanteil ${ferienPct.toFixed(2)}% (Art. 329d OR):`, left + 5, y); doc.text(`CHF ${CHF(ferienHourly)} / h`, right, y, { align: "right" }); y += 5;
  doc.setTextColor(0); doc.setFontSize(10);
  doc.text(`Grundlohn (${(effectiveMin / 60).toFixed(2)} h × CHF ${CHF(grundlohnHourly)})`, left, y); doc.text(`CHF ${CHF(baseGrundlohn)}`, right, y, { align: "right" }); y += 5;
  doc.text(`Ferienanteil (${(effectiveMin / 60).toFixed(2)} h × CHF ${CHF(ferienHourly)})`, left, y); doc.text(`+ CHF ${CHF(baseFerien)}`, right, y, { align: "right" }); y += 5;
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

  // Zeitkompensation (ArG 17b Abs. 3): ab Nacht 25/Jahr werden 10% der
  // Nachtstunden als bezahlte Freizeit gutgeschrieben (keine Geldzulage).
  if (nightShiftsOverLimit > 0) {
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text(
      `Hinweis: ${nightShiftsOverLimit} Nacht(e) >24/Jahr → 10% Zeitkompensation (${fmtHours(nightTimeCompMin)}) wird auf das Komp-Konto gutgeschrieben (ArG Art. 17b Abs. 3).`,
      left, y, { maxWidth: contentWidth },
    );
    doc.setFontSize(10); doc.setTextColor(0); doc.setFont("helvetica", "normal");
    y += 6;
  }

  // Abzuege
  doc.setFont("helvetica", "bold"); doc.text("Abzüge Mitarbeiter", left, y); y += 5;
  doc.setFont("helvetica", "normal");
  for (const [k, d] of Object.entries(deductions)) {
    if (d.pct === 0) continue;
    doc.text(`${k} (${d.pct.toFixed(2)}%)`, left, y);
    doc.text(`- CHF ${CHF(d.amount)}`, right, y, { align: "right" });
    y += 5;
  }
  if (totalDeductionPct === 0) { doc.text("Keine Abzüge konfiguriert", left, y); y += 5; }
  y += 2;
  doc.setFont("helvetica", "bold");
  doc.text(`Total Abzüge (${totalDeductionPct.toFixed(2)}%)`, left, y); doc.text(`- CHF ${CHF(totalDeductionAmount)}`, right, y, { align: "right" });
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
  ];
  if (!profile.birthdate) {
    footerLines.push(`HINWEIS: Geburtsdatum nicht hinterlegt — Ferienanteil mit ${ferienPct.toFixed(2)}% angenommen (Erwachsene). Pruefen ob MA <20 Jahre alt ist (dann 10.64% korrekt).`);
  }
  footerLines.push(`Generiert am ${new Date().toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })} um ${new Date().toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich" })}`);
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
      .update({ storage_path: path, file_size: pdfArrayBuffer.byteLength, uploaded_at: new Date().toISOString(), uploaded_by: auth.user.id, source: "auto" })
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
      source: "auto",
    });
  }

  return NextResponse.json({ success: true, mode: existing ? "regenerated" : "generated" });
}
