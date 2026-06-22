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

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";

interface TimeRange {
  date?: string;
  start?: string;
  end?: string;
  pause?: number;
  technician_id?: string;
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
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
    // Local datetime im Browser-Timezone (Europe/Zurich) interpretieren.
    // Beim Insert in timestamptz wird automatisch in UTC konvertiert.
    const clockInLocal = `${tr.date}T${tr.start}:00`;
    let endLocal = `${tr.date}T${tr.end}:00`;
    // Overnight: end < start -> end ist auf dem naechsten Kalendertag
    if (tr.end < tr.start) {
      const [y, m, d] = tr.date.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1, 12)); // tz-ok: nur Datum-Arithmetik
      const nextDate = next.toISOString().slice(0, 10); // tz-ok: ISO date YYYY-MM-DD
      endLocal = `${nextDate}T${tr.end}:00`;
    }
    const clockIn = new Date(clockInLocal);
    const clockOut = new Date(endLocal);
    if (Number.isNaN(clockIn.getTime()) || Number.isNaN(clockOut.getTime())) {
      errors.push(`Ungueltige Zeit ${tr.date} ${tr.start}-${tr.end}`);
      continue;
    }
    if (clockOut.getTime() <= clockIn.getTime()) {
      errors.push(`Negative Dauer ${tr.date} ${tr.start}-${tr.end}`);
      continue;
    }
    const pauseMin = Number(tr.pause ?? 0) || 0;

    // Idempotenz + Dedup gegen echten Stempel: hat dieser User fuer
    // diesen Job am gleichen KALENDERTAG schon irgendeinen time_entry?
    // Wenn ja → skip. Sein realer Stempel ist die Wahrheit, wir wollen
    // keine zweite (verschobene) Range zusaetzlich auflegen.
    // Tagesgrenze in Europe/Zurich, damit overnight-Faelle (range startet
    // 23:00, Stempel um 23:30 → gleicher Kalendertag) korrekt matchen.
    const dayStartLocal = `${tr.date}T00:00:00`;
    const dayEndLocal = (() => {
      const [y, m, d] = tr.date.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1, 12));
      return `${next.toISOString().slice(0, 10)}T00:00:00`; // tz-ok
    })();
    const dayStart = new Date(dayStartLocal).toISOString();
    const dayEnd = new Date(dayEndLocal).toISOString();
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

    const descSuffix = pauseMin > 0 ? ` (Rapport-Pause: ${pauseMin} min)` : "";
    const { error: insErr } = await admin.from("time_entries").insert({
      user_id: tr.technician_id,
      job_id: report.job_id,
      clock_in: clockIn.toISOString(),
      clock_out: clockOut.toISOString(),
      description: `Auto-Stempel aus Rapport${descSuffix}`,
    });
    if (insErr) {
      errors.push(`${tr.date}: ${insErr.message}`);
      logError("reports.auto-stempel.insert", insErr, { reportId, range: tr });
      continue;
    }
    inserted++;
  }

  return NextResponse.json({ success: true, inserted, skipped, errors });
}
