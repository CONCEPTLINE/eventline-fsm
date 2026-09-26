import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { timingSafeEqual } from "crypto";

// Abhol-Schnittstelle fuer den NAS-Sync-Client (laeuft im Buero/auf dem
// UGREEN und POLLT — das NAS muss dafuer NICHT aus dem Internet
// erreichbar sein).
//
//   GET  → Liste der noch nicht abgeholten Ablagen: pro Datei eine
//          signierte Download-URL (1h) + exakter Zielordner/Dateiname
//          (inkl. Umlaute — die stehen in der DB, nicht im Storage-Key).
//   POST { ids: [...] } → markiert Ablagen als uebertragen (synced_at)
//          und loescht die Dateien aus dem Uebergabe-Bucket.
//
// Auth: Bearer-Token aus env ABLAGE_SYNC_TOKEN (eigenes Secret nur fuer
// diesen Client, timing-safe verglichen). Ohne konfiguriertes Secret
// antwortet die Route 503 — sie ist dann faktisch abgeschaltet.

function tokenOk(request: NextRequest): boolean | null {
  const secret = process.env.ABLAGE_SYNC_TOKEN;
  if (!secret || secret.length < 32) return null; // nicht konfiguriert
  const header = request.headers.get("authorization") ?? "";
  const angeboten = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(angeboten);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Sync nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ablage_items")
      .select("id, ordner_pfad, abgelegt_name, storage_path, file_size, mime_type")
      .is("synced_at", null)
      .neq("storage_path", "")
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);

    const items = [];
    for (const row of data ?? []) {
      const { data: signed } = await admin.storage.from("nas-ablage").createSignedUrl(row.storage_path, 3600);
      if (!signed?.signedUrl) continue;
      items.push({
        id: row.id,
        ordner: row.ordner_pfad,
        dateiname: row.abgelegt_name,
        url: signed.signedUrl,
        file_size: row.file_size,
        mime_type: row.mime_type,
      });
    }
    return NextResponse.json({ success: true, items });
  } catch (e) {
    logError("ablage.sync.get", e);
    return NextResponse.json({ success: false, error: "Sync-Liste fehlgeschlagen" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Sync nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => null);
    const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) : [];
    if (ids.length === 0) {
      return NextResponse.json({ success: false, error: "ids fehlt" }, { status: 400 });
    }
    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from("ablage_items")
      .update({ synced_at: new Date().toISOString() })
      .in("id", ids)
      .is("synced_at", null)
      .select("id, storage_path");
    if (error) throw new Error(error.message);
    const pfade = (rows ?? []).map((r) => r.storage_path).filter(Boolean);
    if (pfade.length > 0) {
      // Uebergabe-Bucket aufraeumen — die Datei liegt jetzt auf dem NAS.
      const { error: remErr } = await admin.storage.from("nas-ablage").remove(pfade);
      if (remErr) logError("ablage.sync.cleanup", remErr, { anzahl: pfade.length });
    }
    return NextResponse.json({ success: true, bestaetigt: (rows ?? []).length });
  } catch (e) {
    logError("ablage.sync.post", e);
    return NextResponse.json({ success: false, error: "Sync-Bestätigung fehlgeschlagen" }, { status: 500 });
  }
}
