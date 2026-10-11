import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { KI_EILIG_DROSSEL_MS } from "@/lib/ki/konstanten";
import { neuesEiligBis } from "@/lib/ki/queue";

// POST /api/ki/wach (Body leer) → 204 — docs/lokale-ki/MASTERPLAN.md §3.2.
// Weckt den Abholtakt des Rigs: ki_status.eilig_bis = jetzt + 90 s; solange
// antwortet GET /api/ki/sync mit naechster_poll_ms 300 statt 2 s Pause.
// Aufruf aus der UI beim Fokus ins NAS-Suchfeld und beim Oeffnen von «Frag
// das Archiv». Drossel: geschrieben wird nur, wenn der bisherige Wert vor
// jetzt + 60 s liegt — die Bedingung steht zusaetzlich im UPDATE, damit
// zwei gleichzeitige Aufrufe nicht beide schreiben. Nur Admin (wie die
// NAS-Seite). Kein Inhalt, keine Nebenwirkung ausser dem Zeitstempel.

export async function POST() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const admin = createAdminClient();
    const jetzt = Date.now();
    const { data: status, error: lesenErr } = await admin.from("ki_status").select("eilig_bis").eq("id", 1).maybeSingle();
    if (lesenErr) throw new Error(lesenErr.message);
    const neu = neuesEiligBis(status?.eilig_bis as string | null | undefined, jetzt);
    if (neu) {
      const grenze = new Date(jetzt + KI_EILIG_DROSSEL_MS).toISOString();
      const { error } = await admin
        .from("ki_status")
        .update({ eilig_bis: neu })
        .eq("id", 1)
        .or(`eilig_bis.is.null,eilig_bis.lt.${grenze}`);
      if (error) throw new Error(error.message);
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    logError("ki.wach", e);
    return NextResponse.json({ success: false, error: "Lokale KI konnte nicht geweckt werden" }, { status: 500 });
  }
}
