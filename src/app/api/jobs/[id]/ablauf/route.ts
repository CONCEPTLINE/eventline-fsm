// /api/jobs/[id]/ablauf — Vermietungs-Ablauf eines Auftrags (docs/barakuba/VERTRAG-ABLAUF.md).
//
//   GET   → AblaufAntwort { ablauf, ereignisse, mails, personal } (404 = Auftrag ohne Ablauf / nicht sichtbar)
//   PATCH → body { felder?: Partial<AblaufFelder>, uebergabe_person_id?, uebergabe_start?, uebergabe_haken?: string[],
//           poller_freigeschaltet?: boolean } → { success, ablauf, warnung? }
//           Felder gelten danach als «manuell» (die Mail-KI überschreibt sie nie). Datum/Beginn und
//           Mieter/Telefon/E-Mail werden in den Auftrag gespiegelt.
//
// Rechte wie Aufträge: GET auftraege:view, PATCH auftraege:edit; gelesen/geschrieben mit dem RLS-Client
// (sieht das Konto den Auftrag nicht, gibt es keinen Ablauf). Personal-Namen/Verfügbarkeit mit dem Admin-Client,
// erst nachdem der Ablauf per RLS sichtbar war. Archivierte Aufträge: PATCH 409.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { AblaufFehler, aendereAblauf, ladeAblaufAntwort } from "@/lib/ablauf/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:view");
  if (auth.error) return auth.error;
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");
  try {
    const antwort = await ladeAblaufAntwort(await createClient(), createAdminClient(), jobId);
    if (!antwort) return fehler("Kein Vermietungs-Ablauf zu diesem Auftrag", 404);
    return NextResponse.json(antwort, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    logError("api.ablauf.get", e, { jobId });
    return fehler("Ablauf konnte nicht geladen werden", 500);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return fehler("Ungültige Anfrage");
  const erlaubt = ["felder", "uebergabe_person_id", "uebergabe_start", "uebergabe_haken", "poller_freigeschaltet"];
  if (!Object.keys(body).some((k) => erlaubt.includes(k))) return fehler("Nichts zu ändern");
  try {
    const erg = await aendereAblauf(await createClient(), jobId, body);
    return NextResponse.json({ success: true, ...erg });
  } catch (e) {
    if (e instanceof AblaufFehler) return fehler(e.message, e.status);
    logError("api.ablauf.patch", e, { jobId });
    return fehler("Ablauf konnte nicht gespeichert werden", 500);
  }
}
