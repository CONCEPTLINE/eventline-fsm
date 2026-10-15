// POST /api/ai/eingang — verarbeitet EIN neues Eingang-Element eines
// Auftrags (KI liest Text/Bild/PDF, pflegt Zusammenfassung, Technik,
// Kundenwuensche und Termin-/Datumsvorschlaege). Kernlogik in
// lib/ai/eingang-verarbeitung.ts — geteilt mit dem Mail-Webhook /api/inbound/mail.
//
// Zugriff: Recht auftraege:edit (die Verarbeitung aendert Technik-Positionen,
// Kundenwuensche und Zusammenfassung per Admin-Client — gleiches Recht wie
// das Bearbeiten im Auftrag; die Eingang-Erfassung erscheint auch nur mit
// diesem Recht) UND der Auftrag ist fuer den User sichtbar (Check ueber den
// USER-scoped Client → jobs-RLS greift).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { aiAvailable, AI_UNAVAILABLE_MSG } from "@/lib/ai/anthropic";
import { verarbeiteEingangItem } from "@/lib/ai/eingang-verarbeitung";
import { auftragArchiviert, AUFTRAG_ARCHIV_MELDUNG } from "@/lib/archiv";
import { archivAntwort } from "@/lib/archiv-server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const auth = await requirePermission("auftraege:edit");
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
  const { data: job } = await supabase.from("jobs").select("id, status").eq("id", job_id).maybeSingle();
  if (!job) return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });
  // Archiv = nur lesen (src/lib/archiv.ts): die Verarbeitung aendert den
  // Auftrag (Zusammenfassung, Technik, Wuensche) — am archivierten nicht mehr.
  if (auftragArchiviert(job.status as string)) return archivAntwort(AUFTRAG_ARCHIV_MELDUNG);

  try {
    const ergebnis = await verarbeiteEingangItem({
      admin: createAdminClient(),
      jobId: job_id,
      itemId: item_id,
      actorUserId: auth.effectiveUserId,
    });
    return NextResponse.json({
      success: true,
      datum_vorschlag: ergebnis.datumVorschlag,
      termin_vorschlaege: ergebnis.terminVorschlaege,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Verarbeitung fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
