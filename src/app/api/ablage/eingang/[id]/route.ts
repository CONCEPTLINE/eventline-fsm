import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";

// Ablage-Mail-Eingang (Migr 282/283):
//   GET    /api/ablage/eingang/<id> — signierte URL zum Uebernehmen in
//          den normalen Ablage-Flow (Datei wird clientseitig geladen).
//   DELETE /api/ablage/eingang/<id> — Eintrag verwerfen bzw. nach der
//          Uebernahme aufraeumen (Zeile + Bucket-Objekt).

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
      .from("ablage_eingang")
      .select("name, mime_type, storage_path")
      .eq("id", id)
      .maybeSingle();
    if (!row || !row.storage_path) {
      return NextResponse.json({ success: false, error: "Eintrag nicht gefunden" }, { status: 404 });
    }
    const { data: signed } = await admin.storage.from("nas-ablage").createSignedUrl(row.storage_path, 300);
    if (!signed?.signedUrl) {
      return NextResponse.json({ success: false, error: "Link konnte nicht erstellt werden" }, { status: 500 });
    }
    return NextResponse.json({ success: true, url: signed.signedUrl, name: row.name, mime: row.mime_type });
  } catch (e) {
    logError("ablage.eingang.get", e);
    return NextResponse.json({ success: false, error: "Abruf fehlgeschlagen" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      return NextResponse.json({ success: false, error: "Ungültige ID" }, { status: 400 });
    }
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("ablage_eingang")
      .delete()
      .eq("id", id)
      .select("storage_path")
      .maybeSingle();
    if (row?.storage_path) {
      await admin.storage.from("nas-ablage").remove([row.storage_path]);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    logError("ablage.eingang.delete", e);
    return NextResponse.json({ success: false, error: "Löschen fehlgeschlagen" }, { status: 500 });
  }
}
