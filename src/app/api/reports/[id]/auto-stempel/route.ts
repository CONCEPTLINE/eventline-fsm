// POST /api/reports/[id]/auto-stempel
//
// Erstellt aus den time_ranges eines abgeschlossenen Rapports
// automatisch time_entries (Stempelzeiten) — aber NUR fuer Techniker
// die selbst Admin sind. Nicht-Admin-Techniker (normale Mitarbeiter)
// muessen real selber stempeln und werden uebersprungen.
//
// Wer den Rapport abschliesst ist egal — der Endpoint wird bei JEDEM
// erfolgreichen Submit aufgerufen, die Range-Filterung pro Techniker-
// Rolle uebernimmt die Logik unten. Use-Case: Admins arbeiten im
// Office an einem Job und rapportieren ihre Stunden direkt — Stempel
// kommt dann automatisch dazu. Mitarbeiter stempeln auf der Baustelle.
//
// Idempotent + KEINE Duplikate mit echtem Stempel:
//   Pro Range pruefen wir ob fuer (user_id, job_id, datum) bereits
//   irgendein time_entry existiert. Falls ja → SKIP. Begruendung:
//   der reale Stempel des Mitarbeiters ist die Wahrheit. Wenn der
//   Mitarbeiter z.B. 16:10-20:07 selber gestempelt hat und im Rapport
//   18:10-22:07 eingetragen ist, darf NICHT zusaetzlich gestempelt
//   werden — das ist konzeptuell die gleiche Arbeitszeit, nur ungenau
//   im Rapport vermerkt. Verdoppelt sonst die Stunden in Abrechnung
//   und Lohn.
//   (Frueher: Check nur ueber clock_in. Hat doppelt erfasst sobald
//   die Rapport-Zeit minimal von der Stempel-Zeit abwich.)
//
// Pause-Behandlung: 1:1 die rapportierte Range stempeln (clock_in =
// start, clock_out = end). Pause wird NICHT abgezogen — die Stempel-
// zeiten zeigen die volle Anwesenheit wie im Rapport eingetragen.
// Pause-Info bleibt als Hinweis in description erhalten.
//
// Lohn-Umbau Phase 4 — nie direkt in gesperrte Monate schreiben, sauber melden
// (errors = Klartext, der Rapport zeigt sie als Hinweis):
//   * Monat abgerechnet (5. des Folgemonats ODER Lohnabrechnung erstellt,
//     lohn_tag_gesperrt) → kein Auto-Stempel.
//   * Ueberschneidung mit einem anderen Stempel der Person → kein Auto-Stempel
//     (der reale Stempel ist die Wahrheit; gilt auch vor Migration 368).
//   * Rapport-Zeit ueber 16 h → kein Auto-Stempel (Zeit im Rapport pruefen).
//   * Fehler der Datenbank → Klartext (src/lib/stempel-meldungen.ts).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInternal } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { istLangerStempel, STEMPEL_LANG_STUNDEN } from "@/lib/lohn/stempel-pruefung";
import { findeUeberlappung, istStempelGesperrt, stempelMeldung, stempelSpanne } from "@/lib/stempel-meldungen";

interface TimeRange {
  date?: string;
  start?: string;
  end?: string;
  pause?: number;
  technician_id?: string;
}

// Europe/Zurich UTC-Offset ("+01:00" oder "+02:00") fuer ein Lokal-Datum.
// Wir MUESSEN das explizit anhaengen — sonst interpretiert `new Date(...)`
// den lokalen String in der SERVER-Timezone (typisch UTC in Vercel), was
// im Sommer 2h und im Winter 1h daneben liegt.
function zurichOffsetForDate(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const probeMs = Date.UTC(y, m - 1, d, 12); // Zurich-Mittag ist in beiden Sommer/Winter eindeutig
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Zurich",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(probeMs));
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const m2 = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m2) return "+01:00";
  const sign = m2[1];
  const hh = m2[2].padStart(2, "0");
  const mm = (m2[3] ?? "00").padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Konvertiert einen lokalen "YYYY-MM-DDTHH:MM:00"-String in Europe/Zurich
 *  in einen Date-Wert (echtes UTC-Timestamp). */
function zurichLocalToDate(localIso: string, dateForOffset: string): Date {
  return new Date(`${localIso}${zurichOffsetForDate(dateForOffset)}`);
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const { id: reportId } = await params;

  const admin = createAdminClient();
  const { data: report, error } = await admin
    .from("service_reports")
    .select("id, job_id, time_ranges, status")
    .eq("id", reportId)
    .maybeSingle();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!report) return NextResponse.json({ success: false, error: "Rapport nicht gefunden" }, { status: 404 });
  if (report.status !== "abgeschlossen") {
    return NextResponse.json({ success: false, error: "Rapport ist nicht abgeschlossen" }, { status: 400 });
  }

  const ranges = (report.time_ranges ?? []) as TimeRange[];

  // Rolle aller Techniker in einem Roundtrip holen, statt pro Range
  // einen Profile-Lookup zu machen.
  const technicianIds = Array.from(new Set(ranges.map((r) => r.technician_id).filter((x): x is string => !!x)));
  const roleByUserId = new Map<string, string>();
  if (technicianIds.length > 0) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, role")
      .in("id", technicianIds);
    for (const p of profiles ?? []) {
      roleByUserId.set(p.id as string, p.role as string);
    }
  }

  let inserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const tr of ranges) {
    if (!tr.date || !tr.start || !tr.end || !tr.technician_id) {
      skipped++; // unvollstaendige Range — kein Stempel
      continue;
    }
    // Nur Admin-Techniker auto-stempeln. Normale Mitarbeiter stempeln real.
    if (roleByUserId.get(tr.technician_id) !== "admin") {
      skipped++;
      continue;
    }
    // Lokal-Zeit als Europe/Zurich interpretieren und explizit in UTC
    // konvertieren. Ohne Offset-Suffix nimmt `new Date()` die SERVER-TZ
    // (typisch UTC auf Vercel) → 1-2h Fehler bei jedem Stempel-Eintrag.
    const clockInLocal = `${tr.date}T${tr.start}:00`;
    let endDate = tr.date;
    let endLocal = `${tr.date}T${tr.end}:00`;
    // Overnight: end < start -> end ist auf dem naechsten Kalendertag
    if (tr.end < tr.start) {
      const [y, m, d] = tr.date.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1, 12)); // tz-ok: nur Datum-Arithmetik
      endDate = next.toISOString().slice(0, 10); // tz-ok: ISO date YYYY-MM-DD
      endLocal = `${endDate}T${tr.end}:00`;
    }
    const clockIn = zurichLocalToDate(clockInLocal, tr.date);
    const clockOut = zurichLocalToDate(endLocal, endDate);
    if (Number.isNaN(clockIn.getTime()) || Number.isNaN(clockOut.getTime())) {
      errors.push(`Ungueltige Zeit ${tr.date} ${tr.start}-${tr.end}`);
      continue;
    }
    if (clockOut.getTime() <= clockIn.getTime()) {
      errors.push(`Negative Dauer ${tr.date} ${tr.start}-${tr.end}`);
      continue;
    }

    // Abrechnungs-Sperre: 5. des Folgemonats (Migration 214) ODER
    // Lohnabrechnung des Monats schon erstellt (364) — dann darf niemand
    // mehr time_entries in diesem Zeitraum anlegen, auch nicht per
    // Auto-Stempel. Der Admin-Client umgeht RLS (der Sperr-Trigger nicht),
    // deshalb hier vorab pruefen und sauber melden.
    const tag = `${tr.date.slice(8, 10)}.${tr.date.slice(5, 7)}.`;
    let locked: boolean;
    try {
      locked = await istStempelGesperrt(admin, [clockIn.toISOString()]);
    } catch (lockErr) {
      errors.push(`${tag}: Sperr-Prüfung fehlgeschlagen — kein Auto-Stempel.`);
      logError("reports.auto-stempel.lock-check", lockErr, { reportId, range: tr });
      continue;
    }
    if (locked) {
      errors.push(`${tag}: Monat abgerechnet — kein Auto-Stempel (nur die Lohnverwaltung per Antrag).`);
      skipped++;
      continue;
    }
    if (istLangerStempel(clockIn.toISOString(), clockOut.toISOString())) {
      errors.push(`${tag}: Rapport-Zeit ${tr.start}–${tr.end} über ${STEMPEL_LANG_STUNDEN} Stunden — kein Auto-Stempel, bitte Zeit prüfen.`);
      skipped++;
      continue;
    }

    const pauseMin = Number(tr.pause ?? 0) || 0;

    // Idempotenz + Dedup gegen echten Stempel: hat dieser User fuer
    // diesen Job am gleichen KALENDERTAG schon irgendeinen time_entry?
    // Wenn ja → skip. Sein realer Stempel ist die Wahrheit, wir wollen
    // keine zweite (verschobene) Range zusaetzlich auflegen.
    // Tagesgrenze in Europe/Zurich, damit overnight-Faelle (range startet
    // 23:00, Stempel um 23:30 → gleicher Kalendertag) korrekt matchen.
    const nextDayIso = (() => {
      const [y, m, d] = tr.date.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1, 12));
      return next.toISOString().slice(0, 10); // tz-ok
    })();
    const dayStart = zurichLocalToDate(`${tr.date}T00:00:00`, tr.date).toISOString();
    const dayEnd = zurichLocalToDate(`${nextDayIso}T00:00:00`, nextDayIso).toISOString();
    const { data: existing } = await admin
      .from("time_entries")
      .select("id")
      .eq("user_id", tr.technician_id)
      .eq("job_id", report.job_id ?? "")
      .gte("clock_in", dayStart)
      .lt("clock_in", dayEnd)
      .limit(1)
      .maybeSingle();
    if (existing) {
      skipped++;
      continue;
    }

    // Ueberschneidung mit einem anderen Stempel (anderer Auftrag, Vortag
    // ueber Mitternacht …): der reale Stempel gilt, kein zweiter darueber.
    const ueb = await findeUeberlappung(admin, {
      userId: tr.technician_id,
      von: clockIn.toISOString(),
      bis: clockOut.toISOString(),
    });
    if (ueb) {
      errors.push(`${tag}: Rapport-Zeit ${tr.start}–${tr.end} überschneidet sich mit dem Stempel ${stempelSpanne(ueb)} — kein Auto-Stempel.`);
      skipped++;
      continue;
    }

    const descSuffix = pauseMin > 0 ? ` (Rapport-Pause: ${pauseMin} min)` : "";
    const { error: insErr } = await admin.from("time_entries").insert({
      user_id: tr.technician_id,
      job_id: report.job_id,
      clock_in: clockIn.toISOString(),
      clock_out: clockOut.toISOString(),
      description: `Auto-Stempel aus Rapport${descSuffix}`,
    });
    if (insErr) {
      errors.push(`${tag}: ${stempelMeldung(insErr, { person: "der Person", ticketHinweis: false })}`);
      logError("reports.auto-stempel.insert", insErr, { reportId, range: tr });
      continue;
    }
    inserted++;
  }

  return NextResponse.json({ success: true, inserted, skipped, errors });
}
