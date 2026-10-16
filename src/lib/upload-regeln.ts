// Server-Regeln fuer Datei-Uploads in den Bucket «documents» — eine Quelle
// fuer /api/upload (interne Konten) und die Partner-Anhaenge
// (/api/partner/anfragen/[id]/dokumente, signierte Upload-URL).
// Client-seitig prueft src/lib/file-upload.ts dieselbe Groessen-Grenze.

/** 25 MB — wie MAX_UPLOAD_SIZE_MB im Browser (src/lib/file-upload.ts). */
export const MAX_UPLOAD_MB = 25;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** MIME-Whitelist — keine ausfuehrbaren Skripte im Bucket. EVENTLINE laedt
 *  nur Bilder, PDFs und Office-Dokumente hoch. */
const ERLAUBTE_MIME_PRAEFIXE = ["image/", "application/pdf", "application/vnd.", "application/msword", "text/plain"];

export function dateitypErlaubt(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return ERLAUBTE_MIME_PRAEFIXE.some((p) => mime.startsWith(p));
}
