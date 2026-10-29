// Lohnabrechnung als PDF erzeugen (Phase 1: aus der Route
// /api/hr/wage-documents/generate hierher verschoben, damit Route UND
// automatischer Lauf dieselbe Funktion ohne HTTP-Umweg nutzen).
//
// Rechnung und PDF-Inhalt sind UNVERÄNDERT gegenüber vorher (ein Rechenkern
// für alle Wege folgt in Phase 2). Neu in Phase 1:
//   - jeder Lade- oder Speicherfehler bricht ab (vorher: still 0 h / Ersatz-
//     werte, gemeldet als Erfolg) — Befund 3/4;
//   - nur gesperrte Monate (ab dem 5. des Folgemonats) — Befund 2;
//   - nie überschreiben: neue Fassung unter eigenem Pfad (./fassung.ts).
// Monate ohne Stunden ergeben weiterhin eine Abrechnung über CHF 0 (Pflicht).
//
// Inhalt der PDF (Art. 323b OR): Firmen-Kopf, Mitarbeiter, Zeitraum, Stunden,
// Brutto mit Zuschlägen, Abzüge (NBU nur wenn versichert, Art. 13 UVV,
// @/lib/nbu-pflicht), Auszahlung, Hinweise.

import type { SupabaseClient } from "@supabase/supabase-js";
import { jsPDF } from "jspdf";
import fs from "node:fs";
import nodePath from "node:path";
import { loadLohnDefaultsStreng, effectivePcts, sumEmployerPct, sumEmployeePct, employerCostsPerHour } from "@/lib/employer-costs";
import { berechneMitarbeiterAbzuege, ladeNbuStatusFuerMonat, nbuBegruendung, type NbuStatus } from "@/lib/nbu-pflicht";
import { effectiveFerienanteil, splitBruttoFerien } from "@/lib/ferienanteil";
import { formatAddressLine, type CompanySettings } from "@/lib/company-settings";
import { swissHolidaysForYear } from "@/lib/swiss-holidays";
import { forEachMinuteSegment, plusTage, weekdayForDateIso } from "@/lib/swiss-time";
import { LohnFehler, ladeArchivierteFassung, ladeGueltigeFassung, speichereFassung, type FassungErgebnis } from "./fassung";
import { monatLabel } from "./monate";

const CHF = (n: number) => new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function fmtHours(min: number) {
  if (min === 0) return "0:00 h";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}:${String(m).padStart(2, "0")} h`;
}

/** Firmenangaben für den PDF-Kopf — Ladefehler bricht ab (kein stiller
 *  Ersatz wie im gecachten loadCompanySettings). */
async function ladeFirmaStreng(admin: SupabaseClient): Promise<CompanySettings> {
  const { data, error } = await admin
    .from("company_settings")
    .select("name, street, zip, city, country, phone, email, website, uid_number, iban")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw new LohnFehler(`Firmenangaben konnten nicht geladen werden: ${error.message}`);
  const t = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    name: t(data?.name) || "EVENTLINE GmbH",
    street: t(data?.street),
    zip: t(data?.zip),
    city: t(data?.city),
    country: t(data?.country) || "Schweiz",
    phone: t(data?.phone),
    email: t(data?.email),
    website: t(data?.website),
    uid_number: t(data?.uid_number),
    iban: t(data?.iban),
  };
}

/** Ist der Monat gesperrt? Gefragt wird die DB (dieselbe Uhr und Regel wie
 *  die Stempel-Sperre, public.is_time_entry_locked). */
export async function istMonatGesperrtDb(admin: SupabaseClient, year: number, month: number): Promise<boolean> {
  const mitte = `${year}-${String(month).padStart(2, "0")}-15T12:00:00Z`;
  const { data, error } = await admin.rpc("is_time_entry_locked", { p_clock_in: mitte });
  if (error) throw new LohnFehler(`Monatssperre konnte nicht geprüft werden: ${error.message}`);
  return data === true;
}

export interface AbrechnungPdf {
  pdf: Uint8Array;
  stunden: number;
  brutto: number;
  netto: number;
}

/** Rechnet den Monat und erzeugt die PDF (speichert nichts). */
export async function erzeugeLohnabrechnungPdf(
  admin: SupabaseClient,
  profileId: string,
  year: number,
  month: number,
): Promise<AbrechnungPdf> {
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("id, full_name, role, email, birthdate")
    .eq("id", profileId)
    .maybeSingle();
  if (profErr) throw new LohnFehler(`Mitarbeiter konnte nicht geladen werden: ${profErr.message}`);
  if (!profile) throw new LohnFehler("Mitarbeiter nicht gefunden", 404);

  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  // Letzter Tag des Monats — die Comp-Zeile matched wenn sie IRGENDWANN
  // im Monat gueltig war (auch bei Einstellung Mitte Monat).
  const lastDayOfMonth = plusTage(monthEnd, -1);

  const { data: comp, error: compErr } = await admin
    .from("employee_compensation")
    .select("hourly_wage_chf, uses_standard_lohn, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, ferienanteil_pct_override, effective_from")
    .eq("profile_id", profileId)
    .lte("effective_from", lastDayOfMonth)
    .or(`effective_to.is.null,effective_to.gte.${monthStart}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (compErr) throw new LohnFehler(`Lohnzeile konnte nicht geladen werden: ${compErr.message}`);
  if (!comp) throw new LohnFehler("Kein Lohn für diesen Monat hinterlegt", 400, "kein_lohn");

  // Saetze zum Monatsanfang der Abrechnung (nicht «heute», Migration 195).
  const lohnDefaults = await loadLohnDefaultsStreng(admin, monthStart);
  const eff = effectivePcts(comp, lohnDefaults);

  const totalDeductionPct = sumEmployeePct(eff);
  if (totalDeductionPct >= 100) {
    throw new LohnFehler(`Summe der Abzüge ist ${totalDeductionPct.toFixed(2)}% — muss < 100% sein. Bitte Lohn-Daten prüfen.`, 400);
  }

  // NBU-Pflicht (Art. 13 UVV) — Ladefehler wirft (kein stilles «nicht versichert»).
  const nbu: NbuStatus = await ladeNbuStatusFuerMonat(admin, profileId, year, month);

  // Stempel mit Jahres-Puffer (Silvester-Schichten), Minuten-Bucketing.
  const fetchStartIso = new Date(`${year - 1}-12-30T00:00:00Z`).toISOString();
  const fetchEndIso = new Date(`${year + 1}-01-02T00:00:00Z`).toISOString();
  const { data: yearEntries, error: entriesErr } = await admin
    .from("time_entries")
    .select("clock_in, clock_out")
    .eq("user_id", profileId)
    .gte("clock_in", fetchStartIso)
    .lt("clock_in", fetchEndIso)
    .not("clock_out", "is", null);
  if (entriesErr) throw new LohnFehler(`Stempelzeiten konnten nicht geladen werden: ${entriesErr.message}`);

  const { data: appts, error: apptsErr } = await admin
    .from("job_appointments")
    .select("start_time, end_time")
    .eq("assigned_to", profileId)
    .gte("start_time", monthStart)
    .lt("start_time", monthEnd);
  if (apptsErr) throw new LohnFehler(`Termine konnten nicht geladen werden: ${apptsErr.message}`);
  let geplantMin = 0;
  for (const a of (appts as { start_time: string; end_time: string }[] | null) ?? []) {
    geplantMin += Math.max(0, Math.floor((new Date(a.end_time).getTime() - new Date(a.start_time).getTime()) / 60000));
  }

  // Rapport-Stunden (nur Info im PDF) direkt aus service_reports.time_ranges.
  const { data: rapportReports, error: rapportErr } = await admin
    .from("service_reports")
    .select("time_ranges")
    .gte("report_date", monthStart)
    .lt("report_date", monthEnd)
    .eq("status", "abgeschlossen");
  if (rapportErr) throw new LohnFehler(`Rapporte konnten nicht geladen werden: ${rapportErr.message}`);
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
    // Segment-Iteration statt pro Minute (CPU-Falle, Skalierbarkeits-
    // Audit) — identische Zaehlung, siehe forEachMinuteSegment.
    forEachMinuteSegment(start, end, (dateIso, hour, minutes) => {
      if (!dateIso.startsWith(yearPrefix)) return;
      let b = buckets.get(dateIso);
      if (!b) {
        const wd = weekdayForDateIso(dateIso);
        b = { date: dateIso, total_minutes: 0, night_minutes: 0, is_sunhol: wd === 0 || holidaySet.has(dateIso), in_current_month: dateIso.startsWith(monthPrefix) };
        buckets.set(dateIso, b);
      }
      b.total_minutes += minutes;
      if (hour >= 23 || hour < 6) b.night_minutes += minutes;
    });
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
  // Auszahlungs-Basis = Gestempelte Stunden (Entscheidung Leo 2026-06-17).
  // Rapport-Stunden bleiben informativ im PDF sichtbar, aber zahlen nicht.
  // 0h ist erlaubt — Abrechnung bleibt Pflicht solange MA angestellt ist,
  // auch wenn in dem Monat nicht gearbeitet wurde (CHF 0.00 dokumentiert).
  const effectiveMin = stempelMin;
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
  // Mitarbeiter-Abzuege mit NBU-Regel (nicht versichert → NBU 0 %).
  const abzuege = berechneMitarbeiterAbzuege(brutto, eff, nbu);
  const totalDeductionAmount = abzuege.total;
  const netto = abzuege.netto;
  const vollkosten = hours * (wage + employer) + totalSurcharge;

  // PDF generieren — Layout portiert von conceptline-fsm lohn-tab.tsx
  // (buildLohnDoc). Struktur: Logo links, Adresse rechts unter dem Logo,
  // Titel + Monat, Trennlinie, kompakter Mitarbeiter-Block.
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const left = 20, right = 190, contentWidth = right - left;
  const company = await ladeFirmaStreng(admin);
  let y = 18;

  // Header: EVENTLINE-Logo links (schwarze Variante fuer weissen Grund),
  // Adress-Zeile rechts drunter (klein, grau). Keine zweite Wortmarke.
  try {
    const logoPath = nodePath.join(process.cwd(), "public", "logo-gmbh-black.png");
    const logoBuf = await fs.promises.readFile(logoPath);
    const logoBase64 = `data:image/png;base64,${logoBuf.toString("base64")}`;
    const logoH = 11; // mm
    const logoW = logoH * (800 / 185); // Aspect 4.32:1
    doc.addImage(logoBase64, "PNG", left, y - 6, logoW, logoH);
  } catch { /* fail-soft */ }
  const addressLine = formatAddressLine(company);
  if (addressLine) {
    doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.setTextColor(115);
    doc.text([company.name, addressLine].filter(Boolean).join(" · "), right, y + 8, { align: "right" });
  }
  y += 18;

  // Titel + Periode
  doc.setTextColor(20); doc.setFontSize(15); doc.setFont("helvetica", "bold");
  doc.text("Lohnabrechnung", left, y);
  doc.setFontSize(11); doc.setFont("helvetica", "normal"); doc.setTextColor(90);
  doc.text(`${MONTH_NAMES[month - 1]} ${year}`, right, y, { align: "right" });
  y += 7;
  doc.setDrawColor(210); doc.line(left, y, right, y); y += 8;

  // Mitarbeiter-Block — Label bold grau, Wert normal dunkel.
  doc.setFontSize(10);
  const info = (k: string, v: string) => {
    doc.setFont("helvetica", "bold"); doc.setTextColor(60); doc.text(k, left, y);
    doc.setFont("helvetica", "normal"); doc.setTextColor(40); doc.text(v, left + 34, y, { maxWidth: contentWidth - 34 });
    y += 5.5;
  };
  info("Mitarbeiter", profile.full_name);
  info("Rolle", profile.role ?? "—");
  info("E-Mail", profile.email ?? "—");
  y += 3;
  doc.setDrawColor(210); doc.line(left, y, right, y); y += 8;
  doc.setTextColor(0);

  // Stunden
  doc.setFont("helvetica", "bold"); doc.text("Stunden", left, y); y += 5;
  doc.setFont("helvetica", "normal");
  const rows: [string, string][] = [
    ["Gestempelt (Basis Abrechnung)", fmtHours(stempelMin)],
    ["Geplant (Termine)", fmtHours(geplantMin)],
    ["Rapportiert", fmtHours(rapportMin)],
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
  for (const z of abzuege.zeilen) {
    // NBU hinterlegt, Person aber nicht NBU-versichert: Zeile mit Begruendung
    // statt Satz, Betrag 0 (Art. 13 UVV).
    if (z.schluessel === "NBU" && eff.nbuPct > 0 && !nbu.versichert) {
      const nbuZeilen: string[] = doc.splitTextToSize(`NBU: ${nbuBegruendung(nbu)}`, contentWidth - 35);
      doc.text(nbuZeilen, left, y);
      doc.text(`CHF ${CHF(0)}`, right, y, { align: "right" });
      y += 5 + (nbuZeilen.length - 1) * 4.5;
      continue;
    }
    if (z.pct === 0) continue;
    doc.text(`${z.schluessel} (${z.pct.toFixed(2)}%)`, left, y);
    doc.text(`- CHF ${CHF(z.betrag)}`, right, y, { align: "right" });
    y += 5;
  }
  if (totalDeductionPct === 0) { doc.text("Keine Abzüge konfiguriert", left, y); y += 5; }
  y += 2;
  doc.setFont("helvetica", "bold");
  doc.text(`Total Abzüge (${abzuege.totalPct.toFixed(2)}%)`, left, y); doc.text(`- CHF ${CHF(totalDeductionAmount)}`, right, y, { align: "right" });
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
  // y muss um die ECHTE gerenderte Hoehe vorruecken — sonst ueberlappen
  // umgebrochene Zeilen die nachfolgenden (HINWEIS-Zeile wird oft 2-3
  // Zeilen lang). splitTextToSize liefert die tatsaechliche Zeilenzahl
  // nach Wrap, ~3.5mm pro Zeile bei 8pt + winziger Absatz-Abstand.
  for (const line of footerLines) {
    const wrapped = doc.splitTextToSize(line, contentWidth);
    doc.text(wrapped, left, y);
    y += wrapped.length * 3.5 + 0.5;
  }

  const pdf = new Uint8Array(doc.output("arraybuffer"));
  return { pdf, stunden: effectiveMin / 60, brutto, netto };
}

/** Abrechnung erzeugen UND als Fassung speichern (Route + Lauf).
 *  - nur gesperrte Monate (sonst LohnFehler 400, code «nicht_gesperrt»)
 *  - gibt es schon eine gültige Fassung und ist `neueFassung` nicht gesetzt:
 *    LohnFehler 409, code «neue_fassung» (die UI fragt nach, der Lauf
 *    überspringt) — nichts wird überschrieben. */
export async function erzeugeUndSpeichereLohnabrechnung(
  admin: SupabaseClient,
  args: {
    profileId: string;
    year: number;
    month: number;
    actorId: string | null;
    actorName: string | null;
    neueFassung: boolean;
  },
): Promise<FassungErgebnis & { stunden: number; brutto: number; netto: number }> {
  const { profileId, year, month } = args;
  const label = monatLabel({ jahr: year, monat: month });
  if (!(await istMonatGesperrtDb(admin, year, month))) {
    throw new LohnFehler(
      `${label} ist noch nicht abgeschlossen — Lohnabrechnungen entstehen erst ab dem 5. des Folgemonats (Monat gesperrt).`,
      400,
      "nicht_gesperrt",
    );
  }
  if (!args.neueFassung) {
    const vorhanden = await ladeGueltigeFassung(admin, profileId, "lohnabrechnung", year, month);
    if (vorhanden) {
      throw new LohnFehler(
        `Für ${label} gibt es schon eine Lohnabrechnung (Fassung ${vorhanden.version}). Eine neue Fassung ersetzt sie, die bisherige bleibt erhalten.`,
        409,
        "neue_fassung",
      );
    }
    const imKorb = await ladeArchivierteFassung(admin, profileId, "lohnabrechnung", year, month);
    if (imKorb) {
      throw new LohnFehler(
        `Die Lohnabrechnung ${label} (Fassung ${imKorb.version}) liegt im Papierkorb. Wiederherstellen — oder eine neue Fassung erzeugen (die im Papierkorb bleibt im Protokoll erhalten).`,
        409,
        "neue_fassung",
      );
    }
  }
  const erg = await erzeugeLohnabrechnungPdf(admin, profileId, year, month);
  const f = await speichereFassung(admin, {
    profileId,
    docType: "lohnabrechnung",
    year,
    month,
    pdf: erg.pdf,
    source: "auto",
    actorId: args.actorId,
    actorName: args.actorName,
    nurWennKeineGueltige: !args.neueFassung,
  });
  if (f.modus === "vorhanden") {
    throw new LohnFehler(`Für ${label} wurde gerade eine Lohnabrechnung gespeichert — nichts überschrieben.`, 409, "neue_fassung");
  }
  return { ...f, stunden: erg.stunden, brutto: erg.brutto, netto: erg.netto };
}
