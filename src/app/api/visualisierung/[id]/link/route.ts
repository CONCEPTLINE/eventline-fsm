import { NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { istHtml } from "@/lib/upload-regeln";
import { logError } from "@/lib/log";
import { erstelleVisualisierungLink } from "@/lib/visualisierung-link";

// POST /api/visualisierung/[id]/link — teilbaren Link (ohne Login) fuer eine
// HTML-Visualisierung erzeugen (Knopf «Link kopieren» im Dokument-Tab).
// Nur wer das Dokument selbst sehen darf (RLS mit der Session des Nutzers).

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;

  const { id } = await params;
  const supabase = await createClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, mime_type")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logError("api.visualisierung.link", error, { id });
    return NextResponse.json({ success: false, error: "Dokument konnte nicht geladen werden" }, { status: 500 });
  }
  if (!doc || !istHtml(doc.mime_type)) {
    return NextResponse.json({ success: false, error: "Visualisierung nicht gefunden" }, { status: 404 });
  }

  return NextResponse.json({ success: true, ...erstelleVisualisierungLink(doc.id) });
}
