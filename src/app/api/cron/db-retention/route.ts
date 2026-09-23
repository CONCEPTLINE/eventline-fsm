/**
 * DB-Retention — laeuft taeglich um 02:00 via Vercel Cron.
 *
 * Raeumt Wachstums-Tabellen auf, die sonst unbegrenzt wachsen
 * (Skalierbarkeits-Audit 2026-09-23):
 *   - user_sessions:            aelter als 180 Tage -> DELETE
 *   - user_passkey_challenges:  abgelaufen seit > 1 Tag -> DELETE
 *   - project_doc_versions:     aelter als 90 Tage -> DELETE, aber die
 *     NEUESTE Version jedes Dokuments bleibt immer erhalten
 *     (aggressivster Wachstumspfad: Snapshot alle ~10 Min beim Tippen)
 *
 * Bewusst NICHT geloescht: permission_audit_log, project_audit
 * (Nachvollziehbarkeit), job_inbox_items (Auftrags-Historie).
 *
 * Authorization wie andere Crons: Bearer CRON_SECRET.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = Date.now();
  const tage = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

  const [sessionsRes, challengesRes] = await Promise.all([
    admin.from("user_sessions").delete({ count: "exact" }).lt("started_at", tage(180)),
    admin.from("user_passkey_challenges").delete({ count: "exact" }).lt("expires_at", tage(1)),
  ]);
  if (sessionsRes.error) logError("cron.db-retention.sessions", sessionsRes.error);
  if (challengesRes.error) logError("cron.db-retention.challenges", challengesRes.error);

  // Doc-Versionen: alt UND nicht die neueste ihres Dokuments. Die
  // Neueste-Ermittlung braucht SQL — wir holen erst die Kandidaten-IDs
  // (alt), dann die jeweils neueste Version pro doc und ziehen sie ab.
  let docVersionen = 0;
  const { data: alteVersionen, error: altErr } = await admin
    .from("project_doc_versions")
    .select("id, doc_id, created_at")
    .lt("created_at", tage(90))
    .limit(5000);
  if (altErr) {
    logError("cron.db-retention.doc-versions.load", altErr);
  } else if (alteVersionen && alteVersionen.length > 0) {
    const docIds = [...new Set(alteVersionen.map((v) => v.doc_id as string))];
    const { data: neueste } = await admin
      .from("project_doc_versions")
      .select("doc_id, id, created_at")
      .in("doc_id", docIds)
      .order("created_at", { ascending: false });
    const neuesteProDoc = new Map<string, string>();
    for (const v of neueste ?? []) {
      if (!neuesteProDoc.has(v.doc_id as string)) neuesteProDoc.set(v.doc_id as string, v.id as string);
    }
    const loeschbar = alteVersionen
      .filter((v) => neuesteProDoc.get(v.doc_id as string) !== (v.id as string))
      .map((v) => v.id as string);
    if (loeschbar.length > 0) {
      const { error: delErr, count } = await admin
        .from("project_doc_versions")
        .delete({ count: "exact" })
        .in("id", loeschbar);
      if (delErr) logError("cron.db-retention.doc-versions.delete", delErr);
      else docVersionen = count ?? 0;
    }
  }

  return NextResponse.json({
    success: true,
    deleted_sessions: sessionsRes.count ?? 0,
    deleted_challenges: challengesRes.count ?? 0,
    deleted_doc_versions: docVersionen,
  });
}
