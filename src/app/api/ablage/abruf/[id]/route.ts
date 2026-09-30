import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";

// GET /api/ablage/abruf/<id> — liefert die signierte Download-URL fuer
// einen vom NAS bereitgestellten Datei-Abruf (Migr 279). Die Datei
// liegt nur kurz im Uebergabe-Bucket; das Housekeeping der Abhol-API
// raeumt Abrufe aelter 1h weg.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      return NextResponse.json({ success: false, error: "Ungültige ID" }, { status: 400 });
    }
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("ablage_abrufe")
      .select("status, storage_path, pfad, fehler")
      .eq("id", id)
      .maybeSingle();
    if (!row) return NextResponse.json({ success: false, error: "Abruf nicht gefunden" }, { status: 404 });
    if (row.status === "fehler") {
      return NextResponse.json({ success: false, error: row.fehler ?? "Abruf fehlgeschlagen" }, { status: 502 });
    }
    if (row.status !== "bereit" || !row.storage_path) {
      return NextResponse.json({ success: false, error: "Noch nicht bereit" }, { status: 409 });
    }
    const name = (row.pfad as string).split("/").pop() ?? "dokument";
    const { data: signed } = await admin.storage
      .from("nas-ablage")
      .createSignedUrl(row.storage_path, 300, { download: name });
    if (!signed?.signedUrl) {
      return NextResponse.json({ success: false, error: "Download-Link konnte nicht erstellt werden" }, { status: 500 });
    }
    return NextResponse.json({ success: true, url: signed.signedUrl, name });
  } catch (e) {
    logError("ablage.abruf", e);
    return NextResponse.json({ success: false, error: "Abruf fehlgeschlagen" }, { status: 500 });
  }
}
