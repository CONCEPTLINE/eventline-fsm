import { NextRequest, NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { erstelleKiTicket, kiTicketKonfiguriert } from "@/lib/ki/ticket";

// POST /api/ki/ticket { scope: "archiv" } → { ticket, exp, url } (SPEC 2.3).
// Das Ticket berechtigt den Browser fuer 10 Minuten zur Direktverbindung
// mit dem Rig fuer Archiv-Fragen (Phase 3) — die Antworten gehen nie ueber
// Vercel/Supabase. Vertrauliche Firmenunterlagen: nur Admins auf einem
// vertrauten Geraet. (Diktate laufen ueber die Warteschlange,
// /api/ki/diktat — dafuer gibt es kein Ticket mehr.)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const scope = String(body?.scope ?? "");
    if (scope !== "archiv") {
      return NextResponse.json({ success: false, error: "scope muss archiv sein" }, { status: 400 });
    }
    const auth = await requireTrustedDevice("nas:ablage");
    if (auth.error) return auth.error;

    const url = (process.env.NEXT_PUBLIC_KI_URL ?? "").trim().replace(/\/+$/, "");
    if (!kiTicketKonfiguriert() || !url) {
      return NextResponse.json({ success: false, error: "Lokale KI ist nicht konfiguriert" }, { status: 503 });
    }
    // sub = der echte angemeldete Nutzer (nicht ein impersoniertes Konto):
    // das Rig protokolliert, wer die Direktverbindung genutzt hat.
    const { ticket, exp } = erstelleKiTicket(auth.user.id, scope);
    return NextResponse.json({ success: true, ticket, exp, url });
  } catch (e) {
    logError("ki.ticket", e);
    return NextResponse.json({ success: false, error: "Ticket konnte nicht erstellt werden" }, { status: 500 });
  }
}
