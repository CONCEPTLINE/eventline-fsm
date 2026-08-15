// POST /api/hr/wage-documents/rebuild-all
//
// EINMALIGER BACKFILL — nuked ALLE Lohnabrechnungen (auch manuell hoch-
// geladene) und generiert sie fuer jeden Mitarbeiter neu, beginnend beim
// aeltesten employee_compensation.effective_from bis zum letzten
// abgeschlossenen Monat (Europe/Zurich).
//
// Filter: nur MA mit mind. einer comp-Zeile und wage_exempt=false auf
// mind. einer davon. auto_lohnabrechnung wird NICHT gefiltert — der
// Backfill deckt alle ab.
//
// Admin-only. Antwort: Summary pro MA (generated / skipped / failed).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { todayLocalIso } from "@/lib/swiss-time";

const BUCKET = "lohndokumente";

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const admin = createAdminClient();

  // 1) Alle wage_documents mit doc_type=lohnabrechnung finden (fuer
  //    Storage-Delete-Liste). Anschliessend Storage + DB nuken.
  const { data: allDocs, error: listErr } = await admin
    .from("wage_documents")
    .select("id, storage_path")
    .eq("doc_type", "lohnabrechnung");
  if (listErr) return NextResponse.json({ success: false, error: listErr.message }, { status: 500 });

  const paths = (allDocs ?? []).map((d) => d.storage_path as string).filter(Boolean);
  let storageDeleted = 0;
  // Supabase Storage remove akzeptiert Batches von max 1000 Pfade.
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const { data } = await admin.storage.from(BUCKET).remove(chunk);
    storageDeleted += (data ?? []).length;
  }

  const { error: delErr } = await admin
    .from("wage_documents")
    .delete()
    .eq("doc_type", "lohnabrechnung");
  if (delErr) return NextResponse.json({ success: false, error: `Delete: ${delErr.message}` }, { status: 500 });
  const dbDeleted = allDocs?.length ?? 0;

  // 2) Kandidaten laden: pro MA aeltestes effective_from, wenn mindestens
  //    eine Comp-Zeile wage_exempt=false ist. wage_exempt=false wird
  //    einfach als "hat mal Lohn bezogen" interpretiert — MA die IMMER
  //    exempt waren werden gar nicht generiert.
  const { data: comps, error: compErr } = await admin
    .from("employee_compensation")
    .select("profile_id, effective_from, wage_exempt")
    .order("effective_from", { ascending: true });
  if (compErr) return NextResponse.json({ success: false, error: `Comp-Load: ${compErr.message}` }, { status: 500 });

  const earliestFrom = new Map<string, string>(); // profile_id -> YYYY-MM-DD
  const hasPaidRow = new Set<string>();
  for (const c of comps ?? []) {
    const pid = c.profile_id as string;
    if (!earliestFrom.has(pid)) earliestFrom.set(pid, c.effective_from as string);
    if (!c.wage_exempt) hasPaidRow.add(pid);
  }

  // Letzter abgeschlossener Monat (Europe/Zurich).
  const today = todayLocalIso();
  const [ty, tm] = today.split("-").map(Number);
  const cutoffYear = tm === 1 ? ty - 1 : ty;
  const cutoffMonth = tm === 1 ? 12 : tm - 1;

  // 3) Fuer jeden MA alle Monate von aeltestem effective_from bis cutoff
  //    sequentiell generieren. Nutzt die bestehende Generate-Route via
  //    Fetch + CRON_SECRET-Bearer (System-Aufruf, uploaded_by=null).
  const origin = new URL(req.url).origin;
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({
      success: false,
      error: "CRON_SECRET fehlt — kann interne generate-Route nicht rufen.",
    }, { status: 503 });
  }

  const perMa: { profile_id: string; months: number; generated: number; failed: number; errors: string[] }[] = [];
  let totalGenerated = 0, totalFailed = 0;

  for (const [profileId, fromIso] of earliestFrom.entries()) {
    if (!hasPaidRow.has(profileId)) continue;
    const [fy, fm] = fromIso.split("-").map(Number);
    const monthsToDo: { year: number; month: number }[] = [];
    let y = fy, m = fm;
    while (y < cutoffYear || (y === cutoffYear && m <= cutoffMonth)) {
      monthsToDo.push({ year: y, month: m });
      m++; if (m > 12) { m = 1; y++; }
    }

    const summary = { profile_id: profileId, months: monthsToDo.length, generated: 0, failed: 0, errors: [] as string[] };
    for (const { year, month } of monthsToDo) {
      try {
        const res = await fetch(`${origin}/api/hr/wage-documents/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cronSecret}` },
          body: JSON.stringify({ profile_id: profileId, year, month }),
        });
        const j = await res.json().catch(() => ({}));
        if (j.success) summary.generated++;
        else {
          summary.failed++;
          summary.errors.push(`${year}-${String(month).padStart(2, "0")}: ${j.error ?? `HTTP ${res.status}`}`);
        }
      } catch (e) {
        summary.failed++;
        summary.errors.push(`${year}-${String(month).padStart(2, "0")}: ${e instanceof Error ? e.message : "fetch-Fehler"}`);
      }
    }
    perMa.push(summary);
    totalGenerated += summary.generated;
    totalFailed += summary.failed;
  }

  return NextResponse.json({
    success: true,
    deleted: { storage: storageDeleted, db: dbDeleted },
    cutoff: `${cutoffYear}-${String(cutoffMonth).padStart(2, "0")}`,
    candidates: perMa.length,
    total_generated: totalGenerated,
    total_failed: totalFailed,
    per_ma: perMa,
  });
}
