import { createAdminClient } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { istIntern } from "@/lib/roles";
import { uploadArchivSperre } from "@/lib/archiv-server";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, dateitypErlaubt, speicherTyp } from "@/lib/upload-regeln";

export const maxDuration = 30;

// Erlaubte Path-Prefixes — alle Upload-Sites in der App schreiben in einen
// dieser Top-Level-Ordner. Path-Traversal (`..`, leading `/`, `//`) ist
// gesperrt; ohne Prefix-Match kommt der Upload nicht durch. Das schliesst
// Path-Hijacking (User schickt fremden Pfad und ueberschreibt fremde Files
// ueber upsert:true).
//
// Quellen der Prefixes (aus 'const path = ...' in der App):
//   - jobs/             → auftraege/neu, auftraege/[id]
//   - raeume/           → raeume/[id]
//   - standorte/        → standorte/[id]
//   - todos/            → todos/page
//   - tickets/          → new-ticket-modal
//   - vertrieb/         → vertrieb/page (Offerten-PDF)
//   - partner-anfragen/ → interne Ablage zu Partner-Anfragen (das Partner-
//                         portal selbst laedt seit 2026-10-16 ueber
//                         /api/partner/anfragen/[id]/dokumente hoch)
//   - rapport-photos/   → rapport-form-modal
//   - signatures/client + signatures/tech → rapport-form-modal
//   - projekte/         → Projekte-Detail
const ALLOWED_PREFIXES = [
  "jobs/",
  "raeume/",
  "standorte/",
  "todos/",
  "tickets/",
  "vertrieb/",
  "partner-anfragen/",
  "rapport-photos/",
  "signatures/",
  "projekte/",
] as const;

function isPathSafe(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("..")) return false;
  if (path.includes("//") || path.includes("\\\\")) return false;
  if (path.length > 512) return false;
  return ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser();
    if (auth.error) return auth.error;
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const path = formData.get("path") as string;

    if (!file || !path) {
      return NextResponse.json({ success: false, error: "File and path required" }, { status: 400 });
    }

    if (!isPathSafe(path)) {
      logError("api.upload.path-rejected", null, { userId: auth.user.id, path });
      return NextResponse.json({ success: false, error: "Ungültiger Upload-Pfad" }, { status: 400 });
    }

    // HTML-Visualisierungen nur an Auftraegen — nur dort spielt die Vorschau
    // sie ueber /api/visualisierung/[id] aus (siehe upload-regeln.ts).
    if (!dateitypErlaubt(file.type, { html: path.startsWith("jobs/") })) {
      logError("api.upload.mime-rejected", null, { userId: auth.user.id, mime: file.type });
      return NextResponse.json({ success: false, error: `Dateityp nicht erlaubt: ${file.type || "unbekannt"}` }, { status: 400 });
    }

    // 25MB — passt zum Client-Limit in src/lib/file-upload.ts. Vorher 10MB
    // serverseitig vs 25MB clientseitig hat fuer Bandbreiten-Verschwendung
    // gesorgt (Client laesst durch, Server lehnt nach kompletten Upload ab).
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ success: false, error: `Datei zu gross (${Math.round(file.size / 1024 / 1024)}MB). Max ${MAX_UPLOAD_MB}MB.` }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Nur interne Konten (die Route schreibt mit dem Admin-Client). Portal-
    // Konten laden hier nie hoch: Partner seit 2026-10-16 ueber
    // /api/partner/anfragen/[id]/dokumente (signierte Upload-URL), Lieferanten
    // ueber /api/lieferant/…/angebot. Intern = Profil mit Nicht-Portal-Rolle —
    // nach roles.ts (PORTAL_ROLLEN) UND nach roles.is_portal in der DB (wie
    // public.is_internal_user(), Migration 308). Kein Profil / unbekannte
    // Rolle = nicht intern. Bewusst die ECHTE Session (auth.user.id), nicht
    // effectiveUserId: ein Admin im View-As bleibt intern.
    // DB-Fehler (Haenger, Timeout) sind Serverfehler, kein fehlendes Recht —
    // sonst saehe ein Techniker einen falschen Rechte-Toast.
    const { data: profil, error: profilErr } = await supabase
      .from("profiles")
      .select("role, is_active")
      .eq("id", auth.user.id)
      .maybeSingle();
    if (profilErr) {
      logError("api.upload.profil", profilErr, { userId: auth.user.id });
      return NextResponse.json({ success: false, error: "Upload fehlgeschlagen — Server-Fehler" }, { status: 500 });
    }
    const { data: rolle, error: rolleErr } = profil?.role
      ? await supabase.from("roles").select("is_portal").eq("slug", profil.role).maybeSingle()
      : { data: null, error: null };
    if (rolleErr) {
      logError("api.upload.rolle", rolleErr, { userId: auth.user.id });
      return NextResponse.json({ success: false, error: "Upload fehlgeschlagen — Server-Fehler" }, { status: 500 });
    }
    const intern = istIntern(profil?.role) && !!rolle && rolle.is_portal !== true;
    if (!intern) {
      logError("api.upload.portal-path-rejected", null, { userId: auth.user.id, path });
      return NextResponse.json({ success: false, error: "Keine Berechtigung für diesen Pfad" }, { status: 403 });
    }

    // Archiv = nur lesen (src/lib/archiv.ts): keine neuen Dateien an
    // archivierten Auftraegen/Projekten/Locations (409) — die documents-Zeile
    // lehnt die DB ohnehin ab, die Datei bliebe sonst verwaist liegen.
    const archivSperre = await uploadArchivSperre(supabase, path);
    if (archivSperre) return archivSperre;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    // upsert:false — verhindert dass User A eine Datei von User B
    // ueberschreibt indem er den Pfad raet. Wer eine bestehende Datei
    // ersetzen will muss erst loeschen, dann neu hochladen — der Caller
    // bekommt einen 500-Konflikt zurueck und kann das in der UI signalisieren.
    const { error } = await supabase.storage.from("documents").upload(path, buffer, {
      contentType: speicherTyp(file.type),
      upsert: false,
    });

    if (error) {
      logError("api.upload.supabase", error, { userId: auth.user.id, path });
      // Spezifische Storage-Fehler durchreichen damit der Client unterscheiden
      // kann (Datei-existiert / Quota / Netzwerk). Sicherheitskritische
      // Details (Path/User) bleiben im logError, nicht in der Response.
      const msg = error.message || "";
      let userMsg = "Upload fehlgeschlagen";
      if (/already exists|duplicate|conflict/i.test(msg)) {
        userMsg = "Datei mit gleichem Pfad existiert bereits";
      } else if (/payload|too large|size/i.test(msg)) {
        userMsg = "Datei zu gross";
      } else if (/forbidden|permission|denied/i.test(msg)) {
        userMsg = "Keine Berechtigung für diesen Pfad";
      }
      return NextResponse.json({ success: false, error: userMsg }, { status: 500 });
    }

    return NextResponse.json({ success: true, path });
  } catch (e) {
    logError("api.upload.exception", e);
    return NextResponse.json({ success: false, error: "Upload fehlgeschlagen — Server-Fehler" }, { status: 500 });
  }
}
