import { createAdminClient } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";

export const maxDuration = 60;

// NAS-Ablage-Upload (Leo 2026-09-26): Datei + Pflicht-Kurzbeschrieb +
// Zielordner → privater Bucket 'nas-ablage', von dort holt das NAS die
// Dateien per Sync ab. BEWUSST OHNE KI: der Dateiinhalt wird nie
// analysiert — der Server fasst nur Dateiname, Beschrieb und Zielordner
// an. Admin-only (sensible Dokumente), Service-Role schreibt in den
// Bucket (keine storage-Policies fuer normale Sessions).

const ALLOWED_MIME_PREFIXES = ["image/", "application/pdf", "application/vnd.", "application/msword", "text/plain", "text/csv", "application/zip"];

/** Zeichen, die in Datei-/Ordnernamen auf NAS/Windows Probleme machen. */
function sanitizeName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function heuteZurich(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const beschriebRaw = (formData.get("beschrieb") as string | null) ?? "";
    const ordner = (formData.get("ordner") as string | null) ?? "";

    const beschrieb = beschriebRaw.trim();
    if (!file || !beschrieb || !ordner) {
      return NextResponse.json({ success: false, error: "Datei, Beschrieb und Zielordner sind Pflicht" }, { status: 400 });
    }
    if (beschrieb.length > 200) {
      return NextResponse.json({ success: false, error: "Beschrieb zu lang (max. 200 Zeichen)" }, { status: 400 });
    }
    if (!ALLOWED_MIME_PREFIXES.some((p) => (file.type || "").startsWith(p))) {
      return NextResponse.json({ success: false, error: `Dateityp nicht erlaubt: ${file.type || "unbekannt"}` }, { status: 400 });
    }
    if (file.size > 50 * 1024 * 1024) {
      return NextResponse.json({ success: false, error: `Datei zu gross (${Math.round(file.size / 1024 / 1024)}MB). Max 50MB.` }, { status: 400 });
    }

    const admin = createAdminClient();

    // Zielordner MUSS aus der gepflegten Struktur stammen — das ist die
    // Whitelist gegen Path-Traversal/erfundene Pfade.
    const { data: ordnerRow } = await admin
      .from("ablage_ordner")
      .select("pfad")
      .eq("pfad", ordner)
      .maybeSingle();
    if (!ordnerRow) {
      return NextResponse.json({ success: false, error: "Unbekannter Zielordner" }, { status: 400 });
    }

    // Ablage-Name (so heisst die Datei am Ende auf dem NAS, Umlaute
    // erlaubt): "JJJJ-MM-TT – Beschrieb – Originalname.ext". Der Storage-
    // Key ist bewusst NICHT dieser Name — Supabase-Keys vertragen keine
    // Umlaute/Sonderzeichen. Datei liegt unter items/<id>; Pfad + Name
    // gehen ueber die Sync-API mit.
    const original = sanitizeName(file.name) || "Dokument";
    const abgelegtName = `${heuteZurich()} – ${sanitizeName(beschrieb)} – ${original}`.slice(0, 240);

    const { data: row, error: dbErr } = await admin.from("ablage_items").insert({
      ordner_pfad: ordnerRow.pfad,
      beschrieb,
      original_name: file.name,
      abgelegt_name: abgelegtName,
      storage_path: "",
      file_size: file.size,
      mime_type: file.type || null,
      created_by: auth.effectiveUserId,
    }).select("id").single();
    if (dbErr || !row) {
      logError("ablage.upload.db", dbErr, { userId: auth.effectiveUserId });
      return NextResponse.json({ success: false, error: "Ablage konnte nicht gespeichert werden" }, { status: 500 });
    }

    const storagePath = `items/${row.id}`;
    const buffer = new Uint8Array(await file.arrayBuffer());
    const { error: upErr } = await admin.storage.from("nas-ablage").upload(storagePath, buffer, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (upErr) {
      // Historie-Row nicht liegen lassen wenn die Datei fehlt.
      await admin.from("ablage_items").delete().eq("id", row.id);
      logError("ablage.upload.storage", upErr, { userId: auth.effectiveUserId });
      return NextResponse.json({ success: false, error: "Upload fehlgeschlagen" }, { status: 500 });
    }
    await admin.from("ablage_items").update({ storage_path: storagePath }).eq("id", row.id);

    return NextResponse.json({ success: true, abgelegt_name: abgelegtName, ordner: ordnerRow.pfad });
  } catch (e) {
    logError("ablage.upload.exception", e);
    return NextResponse.json({ success: false, error: "Upload fehlgeschlagen — Server-Fehler" }, { status: 500 });
  }
}
