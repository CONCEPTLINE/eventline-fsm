import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { istIntern } from "@/lib/roles";
import { DIKTAT_MAX_BYTES, KI_ROUTE_RESERVE_MS, KI_TIMEOUT_DIKTAT_MS } from "@/lib/ki/konstanten";
import { erstelleKiAuftrag, kiOnline, loescheKiAuftrag, loescheKiTmp, speichereKiTmp, warteAufErgebnis } from "@/lib/ki/queue";
import type { DiktatErgebnis, DiktatPayload } from "@/lib/ki/typen";

// Upload (langsames Handy-Netz), Wartezeit auf das Rig (bis 60 s) und
// Aufraeumen muessen in die Funktionslaufzeit passen. Die Wartezeit wird
// in POST zusaetzlich an die Restlaufzeit gekoppelt (Startzeit merken),
// damit Antwort und finally nie vom Laufzeit-Ende abgeschnitten werden.
export const maxDuration = 120;

// POST /api/ki/diktat (multipart `audio`, audio/*, max 10 MB) → { text }.
// Diktat ueber die lokale KI im EVENTLINE-Buero: die Aufnahme liegt nur
// kurz im Uebergabe-Bucket (ki-tmp/<uuid>), das Rig holt den Auftrag
// `diktat` ueber /api/ki/sync ab (vor allen anderen Arten), Whisper
// erkennt den Text, das Ergebnis kommt per POST /api/ki/sync zurueck.
// Ueber die Warteschlange statt direkt Browser -> Rig: die Direktadresse
// ist aus dem Buero-Netz nicht aufloesbar (DNS-Rebind-Schutz des
// Routers) und unterwegs ohnehin nicht erreichbar.
//
// Antworten:
//   200 { success, text }                      — "" = nichts erkannt
//   503 { success:false, offline:true, error } — KI offline (UI: Browser-Diktat)
//   504 { success:false, zeitueberschreitung:true, error }
//   502 { success:false, error }               — Rig meldet einen Fehler
// Aufnahme und Auftragszeile werden in JEDEM Fall wieder geloescht —
// nach 60 s wartet niemand mehr auf den Text (Datenschutz).
//
// Nur interne Mitarbeiter: Partner-/Lieferanten-Portal-Konten haben kein
// Diktat (Rolle des echten angemeldeten Kontos, wie requireAdmin).

/** Dateiname fuers Rig. Das Format erkennt der Decoder am Inhalt — die
 *  Endung ist nur ein Hinweis. */
function diktatDateiName(mime: string): string {
  const sub = mime.split("/")[1] ?? "";
  const endung: Record<string, string> = { mpeg: "mp3", mp4: "m4a", "x-m4a": "m4a", "x-wav": "wav", wave: "wav" };
  return `diktat.${endung[sub] ?? (sub.replace(/[^a-z0-9]/g, "") || "bin")}`;
}

export async function POST(request: NextRequest) {
  // Startzeit der Funktion — die Wartezeit auf das Rig richtet sich nach
  // der Restlaufzeit (siehe maxDuration).
  const start = Date.now();
  const auth = await requireUser();
  if (auth.error) return auth.error;

  try {
    const admin = createAdminClient();
    const { data: profil } = await admin.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
    if (!istIntern(profil?.role as string | null | undefined)) {
      return NextResponse.json({ success: false, error: "Diktat steht nur internen Mitarbeitern zur Verfügung" }, { status: 403 });
    }

    // Offline: sofort zurueck, ohne die Aufnahme anzufassen — das UI
    // nimmt dann die Spracherkennung des Browsers (mit Hinweis).
    if (!(await kiOnline())) {
      return NextResponse.json({ success: false, offline: true, error: "Lokale KI ist offline" }, { status: 503 });
    }

    const formData = await request.formData().catch(() => null);
    const audio = formData?.get("audio");
    if (!audio || typeof audio === "string") {
      return NextResponse.json({ success: false, error: "Aufnahme fehlt (Feld «audio»)" }, { status: 400 });
    }
    // Mime ohne Parameter (audio/webm;codecs=opus -> audio/webm).
    const mime = (audio.type || "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("audio/")) {
      return NextResponse.json({ success: false, error: `Keine Audio-Aufnahme: ${audio.type || "unbekannter Typ"}` }, { status: 400 });
    }
    if (audio.size === 0) {
      return NextResponse.json({ success: false, error: "Aufnahme ist leer" }, { status: 400 });
    }
    if (audio.size > DIKTAT_MAX_BYTES) {
      return NextResponse.json(
        { success: false, error: `Aufnahme zu gross (${(audio.size / 1024 / 1024).toFixed(1)} MB, max. 10 MB)` },
        { status: 400 },
      );
    }

    const bytes = new Uint8Array(await audio.arrayBuffer());
    let storagePath: string | null = null;
    let auftragId: string | null = null;
    try {
      const tmp = await speichereKiTmp(bytes, mime);
      storagePath = tmp.storage_path;
      const payload: DiktatPayload = { storage_path: tmp.storage_path, file_name: diktatDateiName(mime), mime, size: bytes.length };
      auftragId = await erstelleKiAuftrag("diktat", payload, auth.user.id);
      // Hoechstens KI_TIMEOUT_DIKTAT_MS — und nie laenger als die
      // Restlaufzeit abzueglich der Reserve fuer Antwort und Aufraeumen.
      const restlaufzeit = maxDuration * 1000 - (Date.now() - start) - KI_ROUTE_RESERVE_MS;
      const warte = await warteAufErgebnis<DiktatErgebnis>(auftragId, Math.max(0, Math.min(KI_TIMEOUT_DIKTAT_MS, restlaufzeit)));

      if (warte.status === "fertig") {
        if (typeof warte.ergebnis?.text !== "string") {
          return NextResponse.json({ success: false, error: "Lokale KI hat kein gültiges Diktat geliefert" }, { status: 502 });
        }
        return NextResponse.json({ success: true, text: warte.ergebnis.text });
      }
      if (warte.status === "timeout") {
        return NextResponse.json(
          { success: false, zeitueberschreitung: true, error: "Lokale KI antwortet nicht rechtzeitig — bitte nochmals versuchen" },
          { status: 504 },
        );
      }
      logError("ki.diktat.rig", warte.fehler);
      return NextResponse.json({ success: false, error: `Lokale KI konnte das Diktat nicht erkennen: ${warte.fehler}` }, { status: 502 });
    } finally {
      if (storagePath) await loescheKiTmp(storagePath);
      if (auftragId) await loescheKiAuftrag(auftragId);
    }
  } catch (e) {
    logError("ki.diktat", e);
    return NextResponse.json({ success: false, error: "Diktat konnte nicht an die lokale KI übergeben werden" }, { status: 500 });
  }
}
