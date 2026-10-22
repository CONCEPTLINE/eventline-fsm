import { createAdminClient } from "@/lib/supabase/admin";
import { istHtml } from "@/lib/upload-regeln";
import { logError } from "@/lib/log";
import { pruefeVisualisierungLink, visualisierungAntwort } from "@/lib/visualisierung-link";

// GET /ansicht/<token> — öffentliche Ansicht einer HTML-Visualisierung ohne
// Login (geteilter Link, src/lib/visualisierung-link.ts). Gelesen wird mit
// dem Admin-Client, aber nur das eine Dokument, dessen id im signierten
// Token steht. CSP-Sandbox wie /api/visualisierung (next.config.ts).

function nichtVerfuegbar(): Response {
  return new Response(
    "Dieser Link ist abgelaufen oder die Visualisierung wurde entfernt. Bitte bei EVENTLINE einen neuen Link anfragen.",
    { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const docId = pruefeVisualisierungLink(token);
  if (!docId) return nichtVerfuegbar();

  const admin = createAdminClient();
  const { data: doc, error } = await admin
    .from("documents")
    .select("name, storage_path, mime_type")
    .eq("id", docId)
    .maybeSingle();
  if (error) logError("ansicht.doc", error, { docId });
  if (!doc || !istHtml(doc.mime_type)) return nichtVerfuegbar();

  const { data: datei, error: dlErr } = await admin.storage.from("documents").download(doc.storage_path);
  if (dlErr || !datei) {
    logError("ansicht.download", dlErr, { docId });
    return nichtVerfuegbar();
  }
  return visualisierungAntwort(await datei.arrayBuffer(), doc.name);
}
