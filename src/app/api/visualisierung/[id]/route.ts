import { NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { istHtml } from "@/lib/upload-regeln";
import { logError } from "@/lib/log";
import { visualisierungAntwort } from "@/lib/visualisierung-link";

// GET /api/visualisierung/[id] — spielt ein HTML-Dokument (z.B. 3D-Bühnen-
// modell) aus documents als Seite aus. Vorschau im Auftrag (PdfPopup) und
// «In neuem Tab öffnen». ?download=1 → als Datei herunterladen.
//
// Sicherheit: Der CSP fuer diesen Pfad steht in next.config.ts
// (visualisierungCsp): `sandbox allow-scripts` gibt der Seite einen opaken
// Ursprung — kein Zugriff auf Cookies/Session/localStorage der App, keine
// Verbindung zu App oder Supabase, Skripte nur von den freigegebenen CDNs.
// Gelesen wird mit der Session des Nutzers (RLS auf documents + Storage).

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;

  const { id } = await params;
  const supabase = await createClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("name, storage_path, mime_type")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logError("api.visualisierung.doc", error, { id });
    return NextResponse.json({ error: "Dokument konnte nicht geladen werden" }, { status: 500 });
  }
  if (!doc || !istHtml(doc.mime_type)) {
    return NextResponse.json({ error: "Visualisierung nicht gefunden" }, { status: 404 });
  }

  const { data: datei, error: dlErr } = await supabase.storage
    .from("documents")
    .download(doc.storage_path);
  if (dlErr || !datei) {
    logError("api.visualisierung.download", dlErr, { id });
    return NextResponse.json({ error: "Datei nicht verfügbar" }, { status: 404 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  return visualisierungAntwort(await datei.arrayBuffer(), doc.name, download);
}
