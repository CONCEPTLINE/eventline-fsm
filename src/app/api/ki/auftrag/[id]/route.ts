import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { logError } from "@/lib/log";

// GET /api/ki/auftrag/<id> → { status, ergebnis, fehler } (SPEC 2.3).
// Das UI fragt damit im Sekundentakt nach, bis die lokale KI fertig ist.
// Gelesen wird ueber den Nutzer-Client: die RLS-Policy aus Migration 288
// (eigene Zeilen oder Admin) entscheidet, ob der Auftrag sichtbar ist —
// fremde Auftraege sind schlicht «nicht gefunden».

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  try {
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ success: false, error: "Ungültige ID" }, { status: 400 });
    }
    const supabase = await createClient();
    const { data: row, error } = await supabase
      .from("ki_auftraege")
      .select("status, ergebnis, fehler")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });
    return NextResponse.json({ success: true, status: row.status, ergebnis: row.ergebnis ?? null, fehler: row.fehler ?? null });
  } catch (e) {
    logError("ki.auftrag.get", e);
    return NextResponse.json({ success: false, error: "Auftrag konnte nicht gelesen werden" }, { status: 500 });
  }
}
