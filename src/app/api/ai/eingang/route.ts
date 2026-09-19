// POST /api/ai/eingang — verarbeitet EIN neues Eingang-Element eines
// Auftrags (KI liest Text/Bild/PDF, pflegt Zusammenfassung + Zusagen +
// Datumsvorschlag). Kernlogik in lib/ai/eingang-verarbeitung.ts — geteilt
// mit dem Mail-Webhook /api/inbound/mail.
//
// Zugriff: eingeloggter Mitarbeiter, der den Auftrag sehen darf (Check
// ueber den USER-scoped Client → jobs-RLS greift); Partner haben auf
// job_inbox_items ohnehin keinen Select (Migration 232).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { aiAvailable, AI_UNAVAILABLE_MSG } from "@/lib/ai/anthropic";
import { verarbeiteEingangItem } from "@/lib/ai/eingang-verarbeitung";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }

  let body: { job_id?: string; item_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const { job_id, item_id } = body;
  if (!job_id || !item_id || !UUID_RE.test(job_id) || !UUID_RE.test(item_id)) {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }

  // Sichtbarkeit unter USER-RLS pruefen (kein Datenzugriff ohne Auftragsrecht).
  const supabase = await createClient();
  const { data: job } = await supabase.from("jobs").select("id").eq("id", job_id).maybeSingle();
  if (!job) return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });

  try {
    const ergebnis = await verarbeiteEingangItem({
      admin: createAdminClient(),
      jobId: job_id,
      itemId: item_id,
      actorUserId: auth.effectiveUserId,
    });
    return NextResponse.json({
      success: true,
      neue_zusagen: ergebnis.neueZusagen,
      datum_vorschlag: ergebnis.datumVorschlag,
      termin_vorschlaege: ergebnis.terminVorschlaege,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Verarbeitung fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
