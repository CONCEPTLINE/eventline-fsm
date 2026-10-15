import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { KI_VORSCHAU_POLL_MS, KI_VORSCHAU_TIMEOUT_MS } from "@/lib/ki/konstanten";
import { erstelleKiAuftrag, ladeKiBereitschaft, loescheKiAuftrag, warteAufErgebnis } from "@/lib/ki/queue";
import { istSystemPfad, leseNasPfad, type VorschauErgebnis } from "@/lib/ki/bereinigen";
import { ladeIndexZeilenNfc } from "@/lib/ki/kontext";

// GET /api/ablage/vorschau?pfad=<NAS-Pfad> — Vorschaubild einer NAS-Datei fuer die Mini-Vorschau (Einsortieren,
// Doppelte). Statt die ganze Datei ueber den NAS-Sync zu holen (bis ~1 min), rendert die lokale KI die erste Seite als
// kleines JPEG direkt vom NAS (Auftragsart «vorschau», rig/eventline-ki/dienst/app/vorschau.py, Zwischenspeicher nur auf
// dem Rig). Fluechtig wie die Inhaltssuche: warten bis 9 s, die Auftragszeile wird IN JEDEM FALL geloescht; das Bild geht
// ohne Zwischenspeicher an den Browser (no-store) — nichts liegt dauerhaft in einem Cloud-Speicher.
//   200 image/jpeg · 204 keine Vorschau fuer diesen Typ · 400 Pfad ungueltig · 404 nicht im Datei-Index
//   503 { offline | nicht_bereit } (der Browser nimmt dann den bisherigen Weg) · 504 Rig belegt · 502 Rig-Fehler
// Nur Admin (wie die NAS-Seite); nur Pfade aus dem Datei-Index (keine beliebigen Pfade aufs NAS). Logs ohne Pfade.

export const maxDuration = 20;

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const pfad = leseNasPfad(request.nextUrl.searchParams.get("pfad"));
  if (!pfad || istSystemPfad(pfad)) return NextResponse.json({ success: false, error: "Pfad ungültig" }, { status: 400 });

  let auftragId: string | null = null;
  try {
    const admin = createAdminClient();
    const zeile = (await ladeIndexZeilenNfc(admin, [pfad])).get(pfad);
    if (!zeile) return NextResponse.json({ success: false, error: "Datei nicht im NAS-Index" }, { status: 404 });
    const bereit = await ladeKiBereitschaft("vorschau");
    if (bereit !== "bereit") {
      return NextResponse.json(
        { success: false, offline: bereit === "offline", nicht_bereit: bereit === "nicht_bereit", error: "Vorschau der lokalen KI nicht verfügbar" },
        { status: 503 },
      );
    }
    auftragId = await erstelleKiAuftrag("vorschau", { pfad: zeile.pfad, breite: 900 }, auth.user.id);
    const warte = await warteAufErgebnis<VorschauErgebnis>(auftragId, KI_VORSCHAU_TIMEOUT_MS, { pollMs: KI_VORSCHAU_POLL_MS });
    if (warte.status === "timeout") {
      return NextResponse.json({ success: false, zeitueberschreitung: true, error: "Lokale KI gerade belegt" }, { status: 504 });
    }
    if (warte.status === "fehler" || !warte.ergebnis) {
      return NextResponse.json({ success: false, error: "Vorschau nicht möglich" }, { status: 502 });
    }
    const e = warte.ergebnis;
    if ("keine" in e) {
      return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Vorschau": e.grund } });
    }
    return new NextResponse(new Uint8Array(Buffer.from(e.b64, "base64")), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Vorschau-Quelle": e.quelle ?? "",
      },
    });
  } catch (e) {
    logError("ablage.vorschau", e, { id: auftragId });
    return NextResponse.json({ success: false, error: "Vorschau fehlgeschlagen" }, { status: 500 });
  } finally {
    if (auftragId) await loescheKiAuftrag(auftragId);
  }
}
