// Server-Regeln fuer Datei-Uploads in den Bucket «documents» — eine Quelle
// fuer /api/upload (interne Konten) und die Partner-Anhaenge
// (/api/partner/anfragen/[id]/dokumente, signierte Upload-URL).
// Client-seitig prueft src/lib/file-upload.ts dieselbe Groessen-Grenze.

/** 25 MB — wie MAX_UPLOAD_SIZE_MB im Browser (src/lib/file-upload.ts). */
export const MAX_UPLOAD_MB = 25;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** MIME-Whitelist — keine ausfuehrbaren Skripte im Bucket. EVENTLINE laedt
 *  nur Bilder, PDFs und Office-Dokumente hoch (Ausnahme HTML: siehe istHtml). */
const ERLAUBTE_MIME_PRAEFIXE = ["image/", "application/pdf", "application/vnd.", "application/msword", "text/plain"];

export function dateitypErlaubt(
  mime: string | null | undefined,
  opts: { html?: boolean } = {},
): boolean {
  if (!mime) return false;
  if (opts.html && istHtml(mime)) return true;
  return ERLAUBTE_MIME_PRAEFIXE.some((p) => mime.startsWith(p));
}

/** HTML-Visualisierungen (z.B. 3D-Bühnenmodell) — nur fuer interne Konten
 *  (/api/upload, nicht Partner). Im Bucket liegen sie als text/plain (siehe
 *  speicherTyp): eine signierte Storage-URL zeigt nur den Quelltext.
 *  Ausgespielt werden sie ausschliesslich ueber /api/visualisierung/[id] —
 *  mit CSP-Sandbox (opaker Ursprung, kein Zugriff auf Session/App). */
export function istHtml(mime: string | null | undefined): boolean {
  return !!mime && /^text\/html\b/i.test(mime);
}

/** Content-Type im Bucket: HTML nie als text/html, damit die Datei auf der
 *  Storage-Domain nicht ausfuehrbar ist. */
export function speicherTyp(mime: string): string {
  return istHtml(mime) ? "text/plain; charset=utf-8" : mime;
}
