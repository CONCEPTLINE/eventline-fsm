import { createAdminClient } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";

// Schema fuer einen einzelnen Doc-Eintrag in technical_details. Validiert
// damit kein Caller versehentlich (oder absichtlich) andere Felder
// rein-mischt. Path muss zu den vom Storage-Endpoint erlaubten Prefixes
// passen — Storage-Path-Hijacking via fremdem Pfad ist hier nicht moeglich
// weil die Datei separat ueber /api/upload hochgeladen werden muss; aber
// wir blockieren absurde Werte (Strings ueber 1KB, leere Pfade).
interface DocEntry {
  name: string;
  path: string;
  uploaded_at: string;
  /** Ordner-Zuordnung (eine Ebene, frei benannt). Fehlend = Hauptordner. */
  folder?: string;
}

function isValidDoc(d: unknown): d is DocEntry {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.name === "string" && o.name.length > 0 && o.name.length <= 256 &&
    typeof o.path === "string" && o.path.startsWith("standorte/") && o.path.length <= 512 &&
    typeof o.uploaded_at === "string" && o.uploaded_at.length <= 64 &&
    (o.folder === undefined ||
      (typeof o.folder === "string" && o.folder.length > 0 && o.folder.length <= 80))
  );
}

/** Nur die bekannten Felder persistieren — unbekannte Properties fliegen raus. */
function sanitizeDoc(d: DocEntry): DocEntry {
  return {
    name: d.name,
    path: d.path,
    uploaded_at: d.uploaded_at,
    ...(d.folder ? { folder: d.folder } : {}),
  };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("locations:edit");
  if (auth.error) return auth.error;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.docs)) {
    return NextResponse.json({ success: false, error: "docs muss ein Array sein" }, { status: 400 });
  }
  if (body.docs.length > 200) {
    return NextResponse.json({ success: false, error: "Zu viele Dokumente" }, { status: 400 });
  }
  if (!body.docs.every(isValidDoc)) {
    return NextResponse.json({ success: false, error: "Ungültiges Doc-Schema" }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { error } = await supabase
    .from("locations")
    .update({ technical_details: JSON.stringify((body.docs as DocEntry[]).map(sanitizeDoc)) })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
