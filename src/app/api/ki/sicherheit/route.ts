import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { rigAuthFehler } from "@/lib/ki/rig-auth";
import {
  RAPPORT_MAX_ALTER_MS,
  laufFuersRig,
  leseRapportBody,
  pruefeRapport,
  type BefundRoh,
  type LaufRoh,
} from "@/lib/ki/sicherheit-rapport";

// /api/ki/sicherheit — Klartext-Rapport zum taeglichen Sicherheits-Check
// (Trust-one-Repo docs/lokale-ki/SPEC.md §2.3 «Sicherheits-Rapport»). Das Rig fragt alle
// 5 min; die Zahlen stehen deterministisch im Text, die lokale KI erklaert
// nur die Befund-Titel.
//   GET  → { success, lauf: RapportLauf | null } — neuester FERTIGE Lauf der
//          letzten 7 Tage ohne narrative, mit Metadaten seiner Befunde (nie
//          detail ausser name/kind/missing, Info-Befunde nur gezaehlt).
//          Tabelle (noch) nicht da → lauf null. Keine Nebenwirkung.
//   POST { run_id, text } → narrative setzen, nur wenn noch leer.
//          200 { success, laenge } · 400 Form · 404 Lauf unbekannt
//          409 schon gesetzt / Lauf nicht fertig · 422 Text passt nicht zum
//          Lauf (Zahl fremd, Pruefungen/kritische Befunde nicht genannt)
//          · 401/503 Auth · 500 → das Rig versucht es im naechsten Takt.
// Auth: Bearer KI_SYNC_TOKEN. Logs nur mit Codes — nie Titel oder Text.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BODY_MAX = 8 * 1024;
const LAUF_FELDER = "id, started_at, finished_at, source, critical, warnings, checks";

type Admin = ReturnType<typeof createAdminClient>;

function tabelleFehlt(e: { code?: string } | null): boolean {
  return e?.code === "42P01" || e?.code === "PGRST205";
}

async function ladeBefunde(admin: Admin, runId: string): Promise<BefundRoh[]> {
  const { data, error } = await admin
    .from("security_findings")
    .select("severity, category, title, detail")
    .eq("run_id", runId)
    .order("occurred_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(`security_findings: ${error.code ?? error.message}`);
  return (data ?? []) as BefundRoh[];
}

export async function GET(request: NextRequest) {
  const authFehler = rigAuthFehler(request);
  if (authFehler) return authFehler;
  const kopf = { "Cache-Control": "no-store" };
  try {
    const admin = createAdminClient();
    const seit = new Date(Date.now() - RAPPORT_MAX_ALTER_MS).toISOString();
    const { data, error } = await admin
      .from("security_runs")
      .select(LAUF_FELDER)
      .is("narrative", null)
      .not("finished_at", "is", null)
      .gte("started_at", seit)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tabelleFehlt(error)) return NextResponse.json({ success: true, lauf: null }, { headers: kopf });
    if (error) throw new Error(`security_runs: ${error.code ?? error.message}`);
    if (!data) return NextResponse.json({ success: true, lauf: null }, { headers: kopf });
    const lauf = data as LaufRoh;
    const befunde = await ladeBefunde(admin, lauf.id);
    return NextResponse.json({ success: true, lauf: laufFuersRig(lauf, befunde) }, { headers: kopf });
  } catch (e) {
    logError("ki.sicherheit.get", e);
    return NextResponse.json({ success: false, error: "Lauf konnte nicht geladen werden" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authFehler = rigAuthFehler(request);
  if (authFehler) return authFehler;
  const roh = await request.text().catch(() => "");
  if (!roh || roh.length > BODY_MAX) return NextResponse.json({ success: false, error: "Ungültiger Body" }, { status: 400 });
  let json: unknown;
  try {
    json = JSON.parse(roh);
  } catch {
    return NextResponse.json({ success: false, error: "Kein JSON" }, { status: 400 });
  }
  const gelesen = leseRapportBody(json);
  if (!gelesen.ok) return NextResponse.json({ success: false, error: gelesen.fehler }, { status: 400 });
  const { run_id, text } = gelesen.wert;
  try {
    const admin = createAdminClient();
    const { data: lauf, error } = await admin
      .from("security_runs")
      .select("id, finished_at, critical, warnings, checks, narrative")
      .eq("id", run_id)
      .maybeSingle();
    if (error && !tabelleFehlt(error)) throw new Error(`security_runs: ${error.code ?? error.message}`);
    if (!lauf) return NextResponse.json({ success: false, error: "Lauf unbekannt" }, { status: 404 });
    if (lauf.narrative !== null) return NextResponse.json({ success: false, error: "Rapport schon gesetzt" }, { status: 409 });
    if (!lauf.finished_at) return NextResponse.json({ success: false, error: "Lauf nicht fertig" }, { status: 409 });
    const befunde = await ladeBefunde(admin, run_id);
    const grund = pruefeRapport(text, lauf, befunde);
    if (grund) return NextResponse.json({ success: false, error: `Text abgewiesen: ${grund}` }, { status: 422 });
    const { data: gesetzt, error: uErr } = await admin
      .from("security_runs")
      .update({ narrative: text })
      .eq("id", run_id)
      .is("narrative", null)
      .select("id");
    if (uErr) throw new Error(`security_runs update: ${uErr.code ?? uErr.message}`);
    if (!gesetzt?.length) return NextResponse.json({ success: false, error: "Rapport schon gesetzt" }, { status: 409 });
    return NextResponse.json({ success: true, laenge: text.length });
  } catch (e) {
    logError("ki.sicherheit.post", e);
    return NextResponse.json({ success: false, error: "Rapport konnte nicht gespeichert werden" }, { status: 500 });
  }
}
