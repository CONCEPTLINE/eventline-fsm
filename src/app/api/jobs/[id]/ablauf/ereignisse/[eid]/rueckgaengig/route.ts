// POST /api/jobs/[id]/ablauf/ereignisse/[eid]/rueckgaengig — Wirkung eines Ereignisses zurücknehmen
// (Schritt, Zusage, Unterschrift, ergänzte Felder; Felder nur, wo noch der damals gesetzte Wert steht).
// → { success, ablauf }. 409 = schon rückgängig / ohne Wirkung / archiviert. Recht auftraege:edit, RLS-Client.
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { AblaufFehler, ereignisRueckgaengig } from "@/lib/ablauf/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function POST(_req: Request, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id: jobId, eid } = await ctx.params;
  if (!UUID_RE.test(jobId) || !UUID_RE.test(eid)) return fehler("Ungültige ID");
  try {
    const erg = await ereignisRueckgaengig(await createClient(), jobId, eid, auth.effectiveUserId);
    return NextResponse.json({ success: true, ...erg });
  } catch (e) {
    if (e instanceof AblaufFehler) return fehler(e.message, e.status);
    logError("api.ablauf.rueckgaengig", e, { jobId, eid });
    return fehler("Rückgängig fehlgeschlagen", 500);
  }
}
