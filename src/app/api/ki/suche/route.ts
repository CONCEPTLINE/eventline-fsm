import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { KI_SUCHE_LIMIT, KI_SUCHE_POLL_MS, KI_SUCHE_Q_MAX, KI_SUCHE_Q_MIN, KI_SUCHE_TIMEOUT_MS } from "@/lib/ki/konstanten";
import { erstelleKiAuftrag, ladeKiBereitschaft, loescheKiAuftrag, warteAufErgebnis } from "@/lib/ki/queue";
import { leseEingabeText, trefferFuerAnzeige } from "@/lib/ki/bereinigen";
import { ladeIndexZeilenNfc } from "@/lib/ki/kontext";
import type { NasSucheErgebnis, NasSuchePayload } from "@/lib/ki/typen";

// POST /api/ki/suche { q } — NAS-Inhaltssuche ueber die lokale KI
// (docs/lokale-ki/MASTERPLAN.md §3.3). Auftrag `nas_suche` (Prioritaet 90),
// das Rig sucht im Tiefen-Index des Buero-Rigs und meldet nur Pfad, Seite
// und Score zurueck — nie Text. Warten bis 8 s (alle 250 ms), danach wird
// die Zeile IN JEDEM FALL geloescht; ein spaetes Ergebnis nimmt die
// Abhol-API nicht mehr an.
//
// Antworten:
//   200 { success, treffer: [{ pfad, name, ordner, seite, score, geaendert }], gelesen_anteil, dauer_ms, modus? }
//       modus «volltext» = Einbettungsmodell laedt noch (Browser zeigt Hinweis, cacht nicht)
//   400 Suchbegriff fehlt/zu kurz/zu lang (2–200 Zeichen)
//   503 { offline: true } | { nicht_bereit: true } — Rig aus bzw. Art nicht gemeldet
//   504 { zeitueberschreitung: true } — Rig belegt (seriell, z. B. Ablage-OCR)
//   502 Rig meldet einen Fehler
// Treffer nur, wenn der Pfad im Datei-Index steht (nicht 99_System/).
// Nur Admin (wie die NAS-Seite). Logs nie mit Suchbegriff oder Pfaden.

export const maxDuration = 15;

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const q = leseEingabeText(body?.q, KI_SUCHE_Q_MIN, KI_SUCHE_Q_MAX);
  if (!q) {
    return NextResponse.json(
      { success: false, error: `Suchbegriff mit ${KI_SUCHE_Q_MIN} bis ${KI_SUCHE_Q_MAX} Zeichen angeben` },
      { status: 400 },
    );
  }

  let auftragId: string | null = null;
  try {
    const bereit = await ladeKiBereitschaft("nas_suche");
    if (bereit === "offline") {
      return NextResponse.json({ success: false, offline: true, error: "Inhaltssuche nur mit lokaler KI — sie ist gerade offline" }, { status: 503 });
    }
    if (bereit === "nicht_bereit") {
      return NextResponse.json({ success: false, nicht_bereit: true, error: "Inhaltssuche der lokalen KI ist noch nicht eingeschaltet" }, { status: 503 });
    }

    const payload: NasSuchePayload = { q, limit: KI_SUCHE_LIMIT };
    auftragId = await erstelleKiAuftrag("nas_suche", payload, auth.user.id);
    const warte = await warteAufErgebnis<NasSucheErgebnis>(auftragId, KI_SUCHE_TIMEOUT_MS, { pollMs: KI_SUCHE_POLL_MS });

    if (warte.status === "timeout") {
      return NextResponse.json(
        { success: false, zeitueberschreitung: true, error: "Inhaltssuche gerade belegt, gleich nochmals versuchen" },
        { status: 504 },
      );
    }
    if (warte.status === "fehler" || !Array.isArray(warte.ergebnis?.treffer)) {
      logError("ki.suche.rig", "Rig meldet einen Fehler", { id: auftragId });
      return NextResponse.json({ success: false, error: "Lokale KI konnte nicht suchen" }, { status: 502 });
    }

    const ergebnis = warte.ergebnis;
    const admin = createAdminClient();
    // Rig-Pfade sind NFC, der Index speichert die Schreibweise der Platte.
    const index = await ladeIndexZeilenNfc(admin, ergebnis.treffer.map((t) => t.pfad));
    return NextResponse.json({
      success: true,
      treffer: trefferFuerAnzeige(ergebnis.treffer, index),
      gelesen_anteil: ergebnis.index?.gelesen_anteil ?? null,
      dauer_ms: ergebnis.dauer_ms,
      ...(ergebnis.modus ? { modus: ergebnis.modus } : {}),
    });
  } catch (e) {
    // Nur die Meldung des Fehlers (DB/Netz), nie Suchbegriff oder Pfade.
    logError("ki.suche", e, { id: auftragId });
    return NextResponse.json({ success: false, error: "Inhaltssuche fehlgeschlagen" }, { status: 500 });
  } finally {
    if (auftragId) await loescheKiAuftrag(auftragId);
  }
}
