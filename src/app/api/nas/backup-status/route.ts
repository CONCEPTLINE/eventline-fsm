import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { timingSafeEqual } from "crypto";

// NAS-Backup-Status:
//   POST (Bearer ABLAGE_SYNC_TOKEN, vom Backup-Container auf dem UGREEN)
//        { date, status?, size?, db_size?, storage_size? }
//        → protokolliert einen Lauf (status 'ok' oder 'fehler').
//   GET  (Admin-Session) → letzte Laeufe + Frische-Bewertung fuer den
//        Backup-Tab der NAS-Seite.
//
// Gleiches Shared-Secret wie die Ablage-Sync-API — beide Richtungen
// gehoeren zum selben NAS↔FSM-Vertrauensverhaeltnis.

/** Wie alt darf die letzte OK-Meldung sein, bevor sie als "stale" gilt.
 *  Backup laeuft naechtlich 03:00 → 26h laesst einen Puffer fuer
 *  Sommer-/Winterzeit + langsame Laeufe. Gleicher Wert im Cron. */
export const dynamic = "force-dynamic";
const STALE_STUNDEN = 26;

function tokenOk(request: NextRequest): boolean | null {
  const secret = process.env.ABLAGE_SYNC_TOKEN;
  if (!secret || secret.length < 32) return null;
  const header = request.headers.get("authorization") ?? "";
  const angeboten = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(angeboten);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => null);
    const runDate = typeof body?.date === "string" && body.date.trim() ? body.date.trim().slice(0, 40) : null;
    if (!runDate) return NextResponse.json({ success: false, error: "date fehlt" }, { status: 400 });
    const status = body?.status === "fehler" ? "fehler" : "ok";
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null);

    const admin = createAdminClient();
    const { error } = await admin.from("nas_backup_runs").insert({
      run_date: runDate,
      status,
      total_size: s(body?.size),
      db_size: s(body?.db_size),
      storage_size: s(body?.storage_size),
    });
    if (error) throw new Error(error.message);
    return NextResponse.json({ success: true });
  } catch (e) {
    logError("nas.backup-status.post", e);
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }
}

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("nas_backup_runs")
      .select("id, run_date, status, total_size, db_size, storage_size, reported_at")
      .order("reported_at", { ascending: false })
      .limit(14);
    if (error) throw new Error(error.message);

    const runs = data ?? [];
    const letzterOk = runs.find((r) => r.status === "ok") ?? null;
    const alterMs = letzterOk ? Date.now() - new Date(letzterOk.reported_at).getTime() : null;
    const zustand: "ok" | "stale" | "fehler" | "nie" =
      runs.length === 0 ? "nie"
      : letzterOk === null ? "fehler"
      : alterMs! > STALE_STUNDEN * 3600_000 ? "stale"
      : runs[0].status === "fehler" ? "fehler"
      : "ok";

    return NextResponse.json({ success: true, zustand, stale_stunden: STALE_STUNDEN, letzter_ok: letzterOk, runs });
  } catch (e) {
    logError("nas.backup-status.get", e);
    return NextResponse.json({ success: false, error: "Laden fehlgeschlagen" }, { status: 500 });
  }
}
