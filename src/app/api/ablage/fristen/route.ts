import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { todayLocalIso } from "@/lib/swiss-time";
import { entscheideFrist, leseFristEntscheid } from "@/lib/ki/fristen-entscheid";

// POST /api/ablage/fristen — Admin entscheidet ueber eine Frist der
// NAS-Ablage (docs/lokale-ki/MASTERPLAN.md §3.8 MP-7; Gruppe «Fristen» im
// Tab «Ablage», src/components/nas/fristen-gruppe.tsx).
//   Body { id, aktion: "bestaetigen"|"verwerfen"|"erledigt", datum? }
//     bestaetigen: Vorschlag der lokalen KI -> aktiv (Datum vorher aenderbar)
//     verwerfen:   Vorschlag -> verworfen (kommt nie wieder)
//     erledigt:    aktive Frist -> erledigt (keine Erinnerungen mehr)
//   Antwort { success, status?, datum?, error? } — 200 ok (auch derselbe
//   Entscheid ein zweites Mal), 400 Body falsch, 404 unbekannt, 409 schon
//   anders entschieden bzw. Datum fuer dieses Dokument schon vergeben.
// Atomar und idempotent: lib/ki/fristen-entscheid. Logs ohne Inhalte.

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const gelesen = leseFristEntscheid(await request.json().catch(() => null), todayLocalIso());
  if (!gelesen.ok) return NextResponse.json({ success: false, error: gelesen.fehler }, { status: 400 });

  try {
    const ergebnis = await entscheideFrist(createAdminClient(), gelesen.entscheid, auth.user.id, new Date().toISOString());
    return NextResponse.json(
      { success: ergebnis.ok, status: ergebnis.status, datum: ergebnis.datum, error: ergebnis.fehler },
      { status: ergebnis.code },
    );
  } catch (e) {
    logError("ablage.fristen", e, { aktion: gelesen.entscheid.aktion });
    return NextResponse.json({ success: false, error: "Entscheid konnte nicht gespeichert werden" }, { status: 500 });
  }
}
