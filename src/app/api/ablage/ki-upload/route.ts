import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { ABLAGE_MAX_BYTES, ABLAGE_MIME_PREFIXES, KI_BUCKET } from "@/lib/ki/konstanten";
import { erstelleKiAuftrag, kiOnline, kiTmpPfad, loescheKiTmp, speichereKiTmp } from "@/lib/ki/queue";
import type { AblageAnalysePayload } from "@/lib/ki/typen";

export const maxDuration = 60;

// POST /api/ablage/ki-upload (Admin, multipart `file`) → { auftrag_id, tmp_id }
// (SPEC 2.3). Erster Schritt der Ablage ohne Tippen: die Datei geht nach
// nas-ablage/ki-tmp/<uuid> (nur Transit), die lokale KI im Buero liest sie
// und liefert Beschrieb, Typ, Ordner, Frist. Abgelegt wird danach ueber
// /api/ablage/upload mit `tmp_id` — die Datei wird dafuer nicht nochmals
// hochgeladen, sondern im Bucket nach items/<id> verschoben.
//
// Ist die KI offline, antwortet die Route sofort 503 (offline: true): das
// UI geht dann den bisherigen Weg (Beschrieb tippen) — nie stiller
// Fehlschlag, und kein 50-MB-Upload fuer nichts.
//
// DELETE /api/ablage/ki-upload?tmp_id=<uuid> (Admin) → { success } — die
// Karte wurde entfernt, ohne abzulegen: Uebergabe-Datei und Auftrag weg
// (ein gerade laufender Auftrag wird «abgebrochen», sein spaetes Ergebnis
// nimmt die Abhol-API nicht mehr an).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fehlertext eines abgebrochenen laufenden Auftrags. */
const ABGEBROCHEN = "abgebrochen";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    if (!(await kiOnline())) {
      return NextResponse.json(
        { success: false, offline: true, error: "Lokale KI ist offline — Dokument bitte wie bisher beschreiben" },
        { status: 503 },
      );
    }
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file || typeof file === "string") {
      return NextResponse.json({ success: false, error: "Datei fehlt" }, { status: 400 });
    }
    if (!ABLAGE_MIME_PREFIXES.some((p) => (file.type || "").startsWith(p))) {
      return NextResponse.json({ success: false, error: `Dateityp nicht erlaubt: ${file.type || "unbekannt"}` }, { status: 400 });
    }
    if (file.size > ABLAGE_MAX_BYTES) {
      return NextResponse.json({ success: false, error: `Datei zu gross (${Math.round(file.size / 1024 / 1024)}MB). Max 50MB.` }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { tmp_id, storage_path } = await speichereKiTmp(bytes, file.type);
    const payload: AblageAnalysePayload = {
      storage_path,
      file_name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
    };
    let auftrag_id: string;
    try {
      auftrag_id = await erstelleKiAuftrag("ablage_analyse", payload, auth.effectiveUserId);
    } catch (e) {
      // Kein Auftrag -> die Datei hat im Uebergabe-Bucket nichts verloren.
      await loescheKiTmp(storage_path);
      throw e;
    }
    return NextResponse.json({ success: true, auftrag_id, tmp_id });
  } catch (e) {
    logError("ablage.ki-upload", e);
    return NextResponse.json({ success: false, error: "Übergabe an die lokale KI fehlgeschlagen" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  // Nur Admins — und Admins duerfen jeden Auftrag abbrechen, damit ist
  // «eigene Auftraege oder Admin» immer erfuellt.
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const tmpId = (request.nextUrl.searchParams.get("tmp_id") ?? "").trim();
  if (!UUID_RE.test(tmpId)) {
    return NextResponse.json({ success: false, error: "Ungültige tmp_id" }, { status: 400 });
  }
  try {
    const admin = createAdminClient();
    const pfad = kiTmpPfad(tmpId);

    // 1. Datei zuerst: ein noch offener Auftrag, den das Rig genau jetzt
    //    abholt, bekommt so keine Download-URL mehr.
    const { error: remErr } = await admin.storage.from(KI_BUCKET).remove([pfad]);
    if (remErr) throw new Error(`Übergabe-Datei konnte nicht gelöscht werden: ${remErr.message}`);

    // 2. Laeuft der Auftrag gerade -> fehler «abgebrochen» (nicht loeschen:
    //    das Rig meldet sich noch, die Abhol-API nimmt nur `laeuft` an).
    const { error: abbruchErr } = await admin
      .from("ki_auftraege")
      .update({ status: "fehler", fehler: ABGEBROCHEN, ergebnis: null, finished_at: new Date().toISOString() })
      .eq("art", "ablage_analyse")
      .eq("payload->>storage_path", pfad)
      .eq("status", "laeuft");
    if (abbruchErr) throw new Error(abbruchErr.message);

    // 3. Alles andere zu dieser Datei loeschen (offen, fertig, fehler) —
    //    auch eine Zeile, die zwischen 2 und 3 noch von laeuft auf fertig
    //    oder vom Rig auf laeuft gesprungen ist; nur die eben
    //    abgebrochene bleibt.
    const { error: delErr } = await admin
      .from("ki_auftraege")
      .delete()
      .eq("art", "ablage_analyse")
      .eq("payload->>storage_path", pfad)
      .or(`status.neq.fehler,fehler.is.null,fehler.neq.${ABGEBROCHEN}`);
    if (delErr) throw new Error(delErr.message);

    return NextResponse.json({ success: true });
  } catch (e) {
    logError("ablage.ki-upload.abbruch", e, { tmpId });
    return NextResponse.json({ success: false, error: "Abbruch der lokalen KI fehlgeschlagen" }, { status: 500 });
  }
}
