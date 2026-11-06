// POST /api/jobs/[id]/ablauf/schritt — Schritt manuell setzen (docs/barakuba/VERTRAG-ABLAUF.md).
//   body { aktion: "erledigt" | "zurueck", schritt: 1..5 } → { success, ablauf, ereignisId }
//   erledigt N  ⇒ N und alle davor erledigt (ab 2 Datum fixiert → Auftrag 'offen'; ab 4 unterschrieben → für den Partner sichtbar)
//   zurueck N   ⇒ N und alle danach wieder offen (≤ 4: wieder «nicht unterschrieben»)
// Jede Änderung = Ereignis mit Rückgängig. Schritt 5 «Übergabe erfolgt» gibt es nur hier (nie per Mail).
// Recht auftraege:edit, RLS-Client; archivierte Aufträge 409.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { AblaufFehler, schrittManuell } from "@/lib/ablauf/server";
import { istSchritt } from "@/lib/ablauf/schritte";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");
  const b = (await req.json().catch(() => null)) as { aktion?: unknown; schritt?: unknown } | null;
  if (!b || (b.aktion !== "erledigt" && b.aktion !== "zurueck")) return fehler("aktion muss «erledigt» oder «zurueck» sein");
  if (!istSchritt(b.schritt)) return fehler("schritt muss 1 bis 5 sein");
  try {
    const erg = await schrittManuell(await createClient(), jobId, b.aktion, b.schritt, auth.effectiveUserId);
    return NextResponse.json({ success: true, ...erg });
  } catch (e) {
    if (e instanceof AblaufFehler) return fehler(e.message, e.status);
    logError("api.ablauf.schritt", e, { jobId });
    return fehler("Schritt konnte nicht gesetzt werden", 500);
  }
}
