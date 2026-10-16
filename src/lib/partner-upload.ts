// Partnerportal: Anhang an eine EIGENE Anfrage hochladen (Browser).
// Der Server prueft Recht, Status, Groesse und Dateityp und liefert eine
// signierte Upload-URL — die Datei geht direkt in den Storage, an Vercel
// vorbei (wie das Lieferanten-Angebot). Danach legt der Server die
// Dokument-Zeile an (/api/partner/anfragen/[id]/dokumente).

import { createClient } from "@/lib/supabase/client";
import { partnerApi } from "@/lib/partner-api";

/** Eine Datei hochladen; Fehlertext fuer den Toast oder null bei Erfolg. */
export async function partnerAnhangHochladen(jobId: string, file: File): Promise<string | null> {
  const url = `/api/partner/anfragen/${jobId}/dokumente`;
  const start = await partnerApi<{ pfad: string; token: string }>(url, {
    schritt: "start",
    name: file.name,
    groesse: file.size,
    typ: file.type,
  });
  if (!start.ok) return start.fehler ?? "Upload fehlgeschlagen";
  const { error } = await createClient()
    .storage.from("documents")
    .uploadToSignedUrl(start.daten.pfad, start.daten.token, file, { contentType: file.type });
  if (error) return error.message || "Upload fehlgeschlagen";
  const fertig = await partnerApi(url, { schritt: "fertig", pfad: start.daten.pfad, name: file.name });
  return fertig.ok ? null : fertig.fehler ?? "Upload fehlgeschlagen";
}
