import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { istIntern } from "@/lib/roles";
import { PORTALS } from "@/lib/portals";

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
//   - partner-anfragen/ → partner-Portal (Anhaenge bei Anfrage-Erstellung)
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

// MIME-Whitelist — verhindert Upload von ausfuehrbaren Skripten in den
// public-Bucket. Eventline laedt nur Bilder, PDFs und Office-Docs hoch.
const ALLOWED_MIME_PREFIXES = ["image/", "application/pdf", "application/vnd.", "application/msword", "text/plain"];

function isPathSafe(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("..")) return false;
  if (path.includes("//") || path.includes("\\\\")) return false;
  if (path.length > 512) return false;
  return ALLOWED_PREFIXES.some((p) => path.startsWith(p));
}

function isMimeSafe(mime: string): boolean {
  if (!mime) return false;
  return ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p));
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

    if (!isMimeSafe(file.type)) {
      logError("api.upload.mime-rejected", null, { userId: auth.user.id, mime: file.type });
      return NextResponse.json({ success: false, error: `Dateityp nicht erlaubt: ${file.type || "unbekannt"}` }, { status: 400 });
    }

    // 25MB — passt zum Client-Limit in src/lib/file-upload.ts. Vorher 10MB
    // serverseitig vs 25MB clientseitig hat fuer Bandbreiten-Verschwendung
    // gesorgt (Client laesst durch, Server lehnt nach kompletten Upload ab).
    if (file.size > 25 * 1024 * 1024) {
      return NextResponse.json({ success: false, error: `Datei zu gross (${Math.round(file.size / 1024 / 1024)}MB). Max 25MB.` }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Portal-Konten (Partner/Lieferant) duerfen nicht in interne Ordner
    // schreiben (die Route schreibt mit dem Admin-Client). Intern = Profil
    // mit Nicht-Portal-Rolle — nach roles.ts (PORTAL_ROLLEN) UND nach
    // roles.is_portal in der DB (wie public.is_internal_user(), Migration
    // 308). Kein Profil / unbekannte Rolle = nicht intern. Bewusst die
    // ECHTE Session (auth.user.id), nicht effectiveUserId: ein Admin im
    // View-As bleibt intern.
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
      // Partner: nur partner-anfragen/<jobId>/<datei> (eine Ebene, kein '..'
      // — isPathSafe oben). Lieferant & alle anderen: kein Upload hier.
      // Job-ID nur in Kleinbuchstaben (wie job_id::text): documents_insert_
      // partner prueft per LIKE, eine gross geschriebene ID gaebe sonst eine
      // verwaiste Datei ohne documents-Zeile.
      const m = /^partner-anfragen\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+$/.exec(path);
      if (profil?.role !== PORTALS.partner.slug || profil.is_active !== true || !m) {
        logError("api.upload.portal-path-rejected", null, { userId: auth.user.id, path });
        return NextResponse.json({ success: false, error: "Keine Berechtigung für diesen Pfad" }, { status: 403 });
      }
      // Recht und Sichtbarkeit mit dem NUTZER-Client pruefen (wie
      // documents_insert_partner: partner:anfragen:edit; jobs_select ->
      // eigener Standort; Status partner_anfrage/partner_entwurf/offen).
      const nutzer = await createClient();
      const { data: darf, error: darfErr } = await nutzer.rpc("has_permission", { perm: "partner:anfragen:edit" });
      if (darfErr) {
        logError("api.upload.recht", darfErr, { userId: auth.user.id });
        return NextResponse.json({ success: false, error: "Upload fehlgeschlagen — Server-Fehler" }, { status: 500 });
      }
      if (darf !== true) {
        logError("api.upload.portal-recht-fehlt", null, { userId: auth.user.id, path });
        return NextResponse.json({ success: false, error: "Keine Berechtigung für diesen Pfad" }, { status: 403 });
      }
      const { data: job, error: jobErr } = await nutzer
        .from("jobs")
        .select("id")
        .eq("id", m[1])
        .in("status", ["partner_anfrage", "partner_entwurf", "offen"])
        .maybeSingle();
      if (jobErr) {
        logError("api.upload.job", jobErr, { userId: auth.user.id, path });
        return NextResponse.json({ success: false, error: "Upload fehlgeschlagen — Server-Fehler" }, { status: 500 });
      }
      if (!job) {
        logError("api.upload.portal-job-rejected", null, { userId: auth.user.id, path });
        return NextResponse.json({ success: false, error: "Keine Berechtigung für diesen Pfad" }, { status: 403 });
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    // upsert:false — verhindert dass User A eine Datei von User B
    // ueberschreibt indem er den Pfad raet. Wer eine bestehende Datei
    // ersetzen will muss erst loeschen, dann neu hochladen — der Caller
    // bekommt einen 500-Konflikt zurueck und kann das in der UI signalisieren.
    const { error } = await supabase.storage.from("documents").upload(path, buffer, {
      contentType: file.type,
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
