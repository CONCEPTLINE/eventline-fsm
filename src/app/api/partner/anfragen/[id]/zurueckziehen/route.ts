// POST /api/partner/anfragen/[id]/zurueckziehen — Partner zieht eine noch
// nicht bestaetigte Anfrage zurueck (Entwurf / Anfrage).
//
// Ablauf:
//   1. RPC partner_withdraw_anfrage mit dem NUTZER-Client (auth.uid() =
//      Partner): prueft aktiven Partner, Recht partner:anfragen:delete,
//      Standort/Ersteller und Status (seit Migration 308 NULL-fest), loescht
//      documents-Zeilen, Termine und den Auftrag in einer Transaktion und
//      liefert die storage_paths der Anhaenge zurueck.
//   2. Admin-Client entfernt NUR Pfade unter 'partner-anfragen/<jobId>/'
//      aus dem Bucket documents. Partner duerfen dort seit Migration 308
//      selbst nichts loeschen — vorher lief remove() im Browser.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bekannte RPC-Meldungen -> Klartext + Status. Rohe DB-Texte gehen nie
 *  an den Browser (nur ins Log). */
function rpcFehler(message: string | undefined): { error: string; status: number } {
  const m = message ?? "";
  if (/cannot withdraw job in status/i.test(m)) {
    return { error: "Anfrage wurde bereits bearbeitet und kann nicht mehr zurückgezogen werden", status: 409 };
  }
  if (/job not found/i.test(m)) {
    return { error: "Anfrage nicht gefunden", status: 404 };
  }
  if (/forbidden/i.test(m)) {
    return { error: "Kein Zugriff auf diese Anfrage", status: 403 };
  }
  return { error: "Anfrage konnte nicht zurückgezogen werden", status: 500 };
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id: roh } = await params;
  if (!UUID_RE.test(roh)) {
    return NextResponse.json({ success: false, error: "Ungültige ID" }, { status: 400 });
  }
  // Klein wie job_id::text — sonst passt das Ordner-Praefix unten nicht und
  // die Anhaenge einer gross geschriebenen URL blieben liegen.
  const id = roh.toLowerCase();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("partner_withdraw_anfrage", { p_job_id: id });
  if (error) {
    logError("api.partner.zurueckziehen.rpc", error, { userId: auth.user.id, jobId: id });
    const f = rpcFehler(error.message);
    return NextResponse.json({ success: false, error: f.error }, { status: f.status });
  }

  // RPC liefert eine Zeile mit der text[]-Spalte storage_paths
  const paths = ((data as unknown as { storage_paths: string[] | null }[] | null) ?? [])[0]?.storage_paths ?? [];
  const praefix = `partner-anfragen/${id}/`;
  const zuLoeschen = paths.filter((p) => typeof p === "string" && p.startsWith(praefix) && !p.includes(".."));
  const uebersprungen = paths.length - zuLoeschen.length;
  if (uebersprungen > 0) {
    // Anhaenge ausserhalb des Anfrage-Ordners (z. B. intern abgelegt) loescht
    // die Route bewusst nicht — nur protokollieren.
    logError("api.partner.zurueckziehen.fremde-pfade", null, { jobId: id, anzahl: uebersprungen });
  }

  if (zuLoeschen.length > 0) {
    const admin = createAdminClient();
    const { error: rmErr } = await admin.storage.from("documents").remove(zuLoeschen);
    if (rmErr) {
      logError("api.partner.zurueckziehen.storage", rmErr, { jobId: id, anzahl: zuLoeschen.length });
      return NextResponse.json({
        success: true,
        warnung: "Anfrage zurückgezogen, Anhänge konnten aber nicht vollständig entfernt werden",
      });
    }
  }

  return NextResponse.json({ success: true });
}
