import { NextRequest, NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { KI_ARCHIV_FRAGE_MAX, KI_ARCHIV_FRAGE_MIN } from "@/lib/ki/konstanten";
import { erstelleKiAuftrag, ladeKiBereitschaft, raeumeFluechtigeAuf } from "@/lib/ki/queue";
import { leseEingabeText } from "@/lib/ki/bereinigen";
import type { ArchivFragePayload } from "@/lib/ki/typen";

// POST /api/ki/archiv { frage } → { auftrag_id } — «Frag das Archiv»
// (docs/lokale-ki/MASTERPLAN.md §3.4, Entscheid E3). Die Frage geht als
// Auftrag `archiv_frage` (Prioritaet 80) ueber die Warteschlange; das Rig
// sucht und antwortet lokal (gemma3:4b), zurueck kommen nur Antworttext und
// Quellenpfade. Abholen per GET /api/ki/archiv/<id> — die Zeile wird beim
// Lesen geloescht, Reste nach 1 h: geraeumt bei jeder neuen Frage (auch
// wenn das Rig offline ist), dazu raeumeKiAuf im Abholpfad und im Cron.
// Kein Cloud-KI-Anbieter.
//
// Recht wie das bestehende Archiv-Ticket: nas:ablage (faktisch Admin) auf
// einem vertrauten Geraet. created_by = der echte angemeldete Nutzer — nur
// er kann die Antwort abholen. Logs nie mit Frage oder Antwort.
//
// Antworten: 200 { success, auftrag_id } · 400 Frage 3–500 Zeichen ·
// 403 Geraet nicht vertraut · 503 { offline } | { nicht_bereit }.

export async function POST(request: NextRequest) {
  const auth = await requireTrustedDevice("nas:ablage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const frage = leseEingabeText(body?.frage, KI_ARCHIV_FRAGE_MIN, KI_ARCHIV_FRAGE_MAX);
  if (!frage) {
    return NextResponse.json(
      { success: false, error: `Frage mit ${KI_ARCHIV_FRAGE_MIN} bis ${KI_ARCHIV_FRAGE_MAX} Zeichen stellen` },
      { status: 400 },
    );
  }

  try {
    // Reste aelterer Fragen/Suchen (> 1 h) weg — wirft nie.
    await raeumeFluechtigeAuf();
    const bereit = await ladeKiBereitschaft("archiv_frage");
    if (bereit === "offline") {
      return NextResponse.json({ success: false, offline: true, error: "«Frag das Archiv» nur mit lokaler KI — sie ist gerade offline" }, { status: 503 });
    }
    if (bereit === "nicht_bereit") {
      return NextResponse.json({ success: false, nicht_bereit: true, error: "«Frag das Archiv» ist auf der lokalen KI noch nicht eingeschaltet" }, { status: 503 });
    }
    const payload: ArchivFragePayload = { frage };
    const auftragId = await erstelleKiAuftrag("archiv_frage", payload, auth.user.id);
    return NextResponse.json({ success: true, auftrag_id: auftragId });
  } catch (e) {
    logError("ki.archiv", e);
    return NextResponse.json({ success: false, error: "Frage konnte nicht an die lokale KI übergeben werden" }, { status: 500 });
  }
}
