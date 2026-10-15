// POST /api/reports/[id]/finalize — Rapport-Abschluss atomar + idempotent.
//
// Vom Handy (Offline-Rapport, src/lib/offline/rapport-outbox.ts Schritt 5)
// gerufen, sobald Text/Fotos/Unterschriften am Server sind. Buendelt die
// Desktop-Kette (rapport-form-modal.tsx handleFinalSubmit) serverseitig,
// damit ein Netzabbruch keinen Teilzustand hinterlaesst und jeder weitere
// Aufruf nur noch Fehlendes nachholt:
//
//   1. Berechtigung: nur interne Konten (requireInternal), davon Ersteller
//      des Rapports, zugeteilter Techniker des Auftrags
//      (job_appointments.assigned_to) oder Admin.
//   2. Enddatum erreicht (gleiche Regel wie canFinish in auftraege/[id]/
//      page.tsx — Tag in Europe/Zurich) + Pflichtfelder (Arbeitsbeschreibung,
//      pro Zeile Datum/Von/Bis/Techniker). Nur solange der Rapport noch
//      Entwurf ist — ein abgeschlossener wird nicht erneut geprueft.
//   3. service_reports.status = 'abgeschlossen' (quelle-Marker raus, wie
//      Desktop). Trigger 106 (zweiter Abschluss) → 409 code bereits_abgeschlossen.
//      Ebenso, wenn der Auftrag inzwischen archiviert ist (abgeschlossen oder
//      storniert, Archiv = nur lesen, Migration 342) → Nachtrag am Handy.
//   4. jobs.status = 'abgeschlossen' (finish-from-rapport-Logik, Admin-Client);
//      ein archivierter Auftrag wird nie umgestellt.
//   5. PDF via /api/reports/[id]/send-invoice (intern, Cookies weitergereicht;
//      uebersprungen, wenn pdf_url schon gesetzt).
//   6. Auto-Stempel via /api/reports/[id]/auto-stempel (selbst idempotent).
//
// Antwort { success, pdf_url, steps: { rapport, auftrag, pdf, stempel } }.
// success=false nur, wenn Rapport oder Auftrag nicht abgeschlossen werden
// konnten; PDF/Stempel-Fehler stehen in steps («fehler: …») und werden beim
// naechsten Aufruf nachgeholt.

import { NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { localDateIso, todayLocalIso } from "@/lib/swiss-time";
import { logError } from "@/lib/log";
import { auftragArchiviert } from "@/lib/archiv";

interface TimeRange {
  date?: string;
  start?: string;
  end?: string;
  technician_id?: string;
  quelle?: string;
  [k: string]: unknown;
}

type Steps = { rapport: string; auftrag: string; pdf: string; stempel: string };

function fehlendePflichtfelder(workDescription: string | null, ranges: TimeRange[]): string | null {
  if (!(workDescription ?? "").trim()) return "Arbeitsbeschreibung fehlt";
  if (ranges.length === 0) return "Einsatzzeit fehlt";
  for (let i = 0; i < ranges.length; i++) {
    const t = ranges[i];
    const tag = ranges.length > 1 ? `Zeit ${i + 1}: ` : "";
    if (!t.date) return `${tag}Datum fehlt`;
    if (!t.start) return `${tag}Von-Zeit fehlt`;
    if (!t.end) return `${tag}Bis-Zeit fehlt`;
    if (!t.technician_id) return `${tag}Techniker fehlt`;
  }
  return null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const { id: reportId } = await params;
  const uid = auth.effectiveUserId;
  const admin = createAdminClient();

  const { data: report, error: repErr } = await admin
    .from("service_reports")
    .select("id, job_id, created_by, status, work_description, time_ranges, pdf_url")
    .eq("id", reportId)
    .maybeSingle();
  if (repErr) return NextResponse.json({ success: false, error: repErr.message }, { status: 500 });
  if (!report) return NextResponse.json({ success: false, error: "Rapport nicht gefunden" }, { status: 404 });

  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, status, end_date")
    .eq("id", report.job_id)
    .maybeSingle();
  if (jobErr) return NextResponse.json({ success: false, error: jobErr.message }, { status: 500 });
  if (!job) return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });

  // ── 1. Berechtigung ───────────────────────────────────────────────────
  let erlaubt = report.created_by === uid;
  if (!erlaubt) {
    const { data: me } = await admin.from("profiles").select("role").eq("id", uid).maybeSingle();
    erlaubt = me?.role === "admin";
  }
  if (!erlaubt) {
    const { data: zuteilung } = await admin
      .from("job_appointments")
      .select("id")
      .eq("job_id", report.job_id)
      .eq("assigned_to", uid)
      .limit(1)
      .maybeSingle();
    erlaubt = !!zuteilung;
  }
  if (!erlaubt) {
    return NextResponse.json(
      { success: false, error: "Nur Ersteller, zugeteilte Techniker oder Admins dürfen diesen Rapport abschliessen" },
      { status: 403 },
    );
  }

  const steps: Steps = { rapport: "", auftrag: "", pdf: "", stempel: "" };

  // ── 2./3. Rapport abschliessen (nur wenn noch Entwurf) ────────────────
  if (report.status === "abgeschlossen") {
    steps.rapport = "vorhanden";
  } else if (auftragArchiviert(job.status as string)) {
    // Archiv = nur lesen (src/lib/archiv.ts): ein noch offener Rapport an
    // einem abgeschlossenen/stornierten Auftrag wird nicht mehr abgeschlossen
    // und der Auftrag nicht mehr umgestellt — das Handy legt ihn als
    // Nachtrag ans Buero (Code wie beim zweiten Abschluss). Ein bereits
    // abgeschlossener Rapport (oben) holt dagegen PDF/Stempel weiter nach.
    return NextResponse.json(
      {
        success: false,
        code: "bereits_abgeschlossen",
        error: job.status === "storniert"
          ? "Der Auftrag ist storniert — der Rapport kann nicht mehr abgeschlossen werden"
          : "Der Auftrag ist bereits abgeschlossen — der Rapport kann nicht mehr abgeschlossen werden",
      },
      { status: 409 },
    );
  } else {
    // Nur ein ANDERER abgeschlossener Rapport macht diesen zum Nachzuegler.
    // Ein vom Buero ohne Rapport geschlossener Auftrag zaehlt nicht — dann
    // normal abschliessen wie am Desktop (Schritt 4 ist dann «vorhanden»).
    const { data: andererAbgeschlossen, error: andErr } = await admin
      .from("service_reports")
      .select("id")
      .eq("job_id", report.job_id)
      .eq("status", "abgeschlossen")
      .neq("id", reportId)
      .limit(1)
      .maybeSingle();
    if (andErr) return NextResponse.json({ success: false, error: andErr.message }, { status: 500 });
    if (andererAbgeschlossen) {
      return NextResponse.json(
        { success: false, code: "bereits_abgeschlossen", error: "Für diesen Auftrag existiert bereits ein abgeschlossener Rapport" },
        { status: 409 },
      );
    }
    const endDateISO = job.end_date ? localDateIso(new Date(job.end_date as string)) : null;
    if (endDateISO && endDateISO > todayLocalIso()) {
      return NextResponse.json(
        { success: false, code: "enddatum", error: `Auftrag kann erst ab dem Enddatum (${endDateISO.split("-").reverse().join(".")}) abgeschlossen werden` },
        { status: 400 },
      );
    }
    const ranges = (Array.isArray(report.time_ranges) ? report.time_ranges : []) as TimeRange[];
    const fehlt = fehlendePflichtfelder(report.work_description as string | null, ranges);
    if (fehlt) {
      return NextResponse.json({ success: false, code: "pflichtfelder", error: fehlt }, { status: 400 });
    }
    const bereinigt = ranges.map((r) => {
      const kopie = { ...r };
      delete kopie.quelle;
      return kopie;
    });
    const { error: finErr, count } = await admin
      .from("service_reports")
      .update({ status: "abgeschlossen", time_ranges: bereinigt }, { count: "exact" })
      .eq("id", reportId)
      .eq("status", "entwurf");
    if (finErr) {
      if (finErr.code === "23505") {
        return NextResponse.json(
          { success: false, code: "bereits_abgeschlossen", error: "Für diesen Auftrag existiert bereits ein abgeschlossener Rapport" },
          { status: 409 },
        );
      }
      logError("reports.finalize.rapport", finErr, { reportId });
      return NextResponse.json({ success: false, error: finErr.message }, { status: 500 });
    }
    // 0 Zeilen: parallel schon abgeschlossen (eigener zweiter Aufruf) — idempotent weiter.
    steps.rapport = (count ?? 0) > 0 ? "abgeschlossen" : "vorhanden";
  }

  // ── 4. Auftrag abschliessen (finish-from-rapport, Admin-Client) ───────
  // Archivierter Auftrag (abgeschlossen ODER storniert) wird nie umgestellt.
  if (auftragArchiviert(job.status as string)) {
    steps.auftrag = "vorhanden";
  } else {
    const { error: jErr, count } = await admin
      .from("jobs")
      .update({ status: "abgeschlossen" }, { count: "exact" })
      .eq("id", report.job_id);
    if (jErr || (count ?? 0) === 0) {
      logError("reports.finalize.auftrag", jErr ?? new Error("0 Zeilen"), { reportId, jobId: report.job_id });
      return NextResponse.json(
        { success: false, error: jErr?.message ?? "Auftrag konnte nicht geschlossen werden", steps },
        { status: 500 },
      );
    }
    steps.auftrag = "abgeschlossen";
  }

  // Interne Aufrufe der bestehenden Routen — Session-Cookie weiterreichen,
  // damit requireInternal() und der RLS-Select in send-invoice greifen.
  const origin = new URL(req.url).origin;
  const kopf: HeadersInit = { cookie: req.headers.get("cookie") ?? "" };

  // ── 5. PDF (send-invoice) ─────────────────────────────────────────────
  let pdfUrl = (report.pdf_url as string | null) ?? null;
  if (pdfUrl) {
    steps.pdf = "vorhanden";
  } else {
    try {
      const res = await fetch(`${origin}/api/reports/${reportId}/send-invoice`, { method: "POST", headers: kopf });
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
      const { data: nach } = await admin.from("service_reports").select("pdf_url").eq("id", reportId).maybeSingle();
      pdfUrl = (nach?.pdf_url as string | null) ?? null;
      steps.pdf = "erzeugt";
    } catch (err) {
      logError("reports.finalize.pdf", err, { reportId });
      steps.pdf = `fehler: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── 6. Auto-Stempel (selbst idempotent: skip bei vorhandenem Eintrag) ─
  try {
    const res = await fetch(`${origin}/api/reports/${reportId}/auto-stempel`, { method: "POST", headers: kopf });
    const json = (await res.json().catch(() => null)) as { success?: boolean; inserted?: number; error?: string } | null;
    if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
    steps.stempel = `${json.inserted ?? 0} Einträge`;
  } catch (err) {
    logError("reports.finalize.auto-stempel", err, { reportId });
    steps.stempel = `fehler: ${err instanceof Error ? err.message : String(err)}`;
  }

  return NextResponse.json({ success: true, pdf_url: pdfUrl, steps });
}
