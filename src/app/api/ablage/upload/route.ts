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

import { baueAblageName, dokTyp } from "@/lib/ablage-doktypen";

const ALLOWED_MIME_PREFIXES = ["image/", "application/pdf", "application/vnd.", "application/msword", "text/plain", "text/csv", "application/zip"];

function heuteZurich(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const ordner = (formData.get("ordner") as string | null) ?? "";
    const s = (k: string) => ((formData.get(k) as string | null) ?? "").trim().slice(0, 120);
    // Gefuehrtes Namensschema (lib/ablage-doktypen): Typ + Betreff sind
    // Pflicht; typ-abhaengige Zusatzfelder (Partei/Nummer) validiert der
    // Server nochmal — der finale Name wird HIER gebaut, nie vom Client.
    const typKey = s("typ") || "sonstiges";
    const betreff = s("betreff");
    const partei = s("partei");
    const nummer = s("nummer");
    const dokDatum = s("dok_datum");

    if (!file || !betreff || !ordner) {
      return NextResponse.json({ success: false, error: "Datei, Betreff und Zielordner sind Pflicht" }, { status: 400 });
    }
    const typ = dokTyp(typKey);
    if (!typ) {
      return NextResponse.json({ success: false, error: "Unbekannter Dokumenttyp" }, { status: 400 });
    }
    if (typ.partei?.pflicht && !partei) {
      return NextResponse.json({ success: false, error: `${typ.partei.label} ist bei «${typ.label}» Pflicht` }, { status: 400 });
    }
    if (dokDatum && !/^\d{4}-\d{2}-\d{2}$/.test(dokDatum)) {
      return NextResponse.json({ success: false, error: "Ungültiges Dokument-Datum" }, { status: 400 });
    }
    if (!ALLOWED_MIME_PREFIXES.some((p) => (file.type || "").startsWith(p))) {
      return NextResponse.json({ success: false, error: `Dateityp nicht erlaubt: ${file.type || "unbekannt"}` }, { status: 400 });
    }
    if (file.size > 50 * 1024 * 1024) {
      return NextResponse.json({ success: false, error: `Datei zu gross (${Math.round(file.size / 1024 / 1024)}MB). Max 50MB.` }, { status: 400 });
    }

    const admin = createAdminClient();

    // Zielordner MUSS aus der gepflegten Struktur stammen — das ist die
    // Whitelist gegen Path-Traversal/erfundene Pfade. Deaktivierte
    // Ordner (aktiv=false) sind bewusst NICHT waehlbar.
    const { data: ordnerRow } = await admin
      .from("ablage_ordner")
      .select("pfad, aktiv")
      .eq("pfad", ordner)
      .maybeSingle();
    if (!ordnerRow) {
      return NextResponse.json({ success: false, error: "Unbekannter Zielordner" }, { status: 400 });
    }
    if (!ordnerRow.aktiv) {
      return NextResponse.json({ success: false, error: "Dieser Ordner ist deaktiviert" }, { status: 400 });
    }
    // Deaktivierung vererbt sich auf den ganzen Zweig: ist irgendein
    // uebergeordneter Ordner deaktiviert, ist auch dieses Ziel gesperrt.
    const { data: inaktive } = await admin.from("ablage_ordner").select("pfad").eq("aktiv", false);
    if ((inaktive ?? []).some((r) => ordnerRow.pfad === r.pfad || ordnerRow.pfad.startsWith(r.pfad + "/"))) {
      return NextResponse.json({ success: false, error: "Ein übergeordneter Ordner ist deaktiviert" }, { status: 400 });
    }

    // Ablage-Name (so heisst die Datei am Ende auf dem NAS, Umlaute
    // erlaubt) — deterministisch aus dem Typ-Schema gebaut. Der Storage-
    // Key ist bewusst NICHT dieser Name — Supabase-Keys vertragen keine
    // Umlaute/Sonderzeichen. Datei liegt unter items/<id>; Pfad + Name
    // gehen ueber die Sync-API mit.
    const abgelegtName = baueAblageName(
      { typKey, betreff, partei, nummer, dokDatum },
      file.name,
      heuteZurich(),
    );
    // Historie/Suche: der Beschrieb ist die menschenlesbare Kurzform.
    const beschrieb = [typ.key === "sonstiges" ? null : typ.label, betreff, partei || null, nummer || null]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200);

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
