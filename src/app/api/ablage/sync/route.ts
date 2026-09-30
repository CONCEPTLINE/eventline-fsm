import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { timingSafeEqual } from "crypto";

// Abhol-Schnittstelle fuer den NAS-Sync-Client (laeuft im Buero/auf dem
// UGREEN und POLLT — das NAS muss dafuer NICHT aus dem Internet
// erreichbar sein).
//
//   GET  → Liste der noch nicht abgeholten Ablagen: pro Datei eine
//          signierte Download-URL (1h) + exakter Zielordner/Dateiname
//          (inkl. Umlaute — die stehen in der DB, nicht im Storage-Key).
//          Zusaetzlich `ordner`: im FSM neu angelegte Ordner, die der
//          Client physisch auf dem NAS erstellen soll (Leo 2026-09-30).
//   POST { ids: [...], ordner: [...] } → markiert Ablagen als uebertragen
//          (synced_at, loescht Dateien aus dem Uebergabe-Bucket) bzw.
//          bestaetigt erstellte Ordner (nas_ausstehend -> false).
//
// Auth: Bearer-Token aus env ABLAGE_SYNC_TOKEN (eigenes Secret nur fuer
// diesen Client, timing-safe verglichen). Ohne konfiguriertes Secret
// antwortet die Route 503 — sie ist dann faktisch abgeschaltet.

function tokenOk(request: NextRequest): boolean | null {
  const secret = process.env.ABLAGE_SYNC_TOKEN;
  if (!secret || secret.length < 32) return null; // nicht konfiguriert
  const header = request.headers.get("authorization") ?? "";
  const angeboten = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(angeboten);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Sync nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ablage_items")
      .select("id, ordner_pfad, abgelegt_name, storage_path, file_size, mime_type")
      .is("synced_at", null)
      .neq("storage_path", "")
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);

    const items = [];
    for (const row of data ?? []) {
      const { data: signed } = await admin.storage.from("nas-ablage").createSignedUrl(row.storage_path, 3600);
      if (!signed?.signedUrl) continue;
      items.push({
        id: row.id,
        ordner: row.ordner_pfad,
        dateiname: row.abgelegt_name,
        url: signed.signedUrl,
        file_size: row.file_size,
        mime_type: row.mime_type,
      });
    }
    // Im FSM angelegte Ordner, die auf dem NAS noch fehlen — sortiert,
    // damit Eltern vor ihren Unterordnern erstellt werden.
    const { data: ausstehend } = await admin
      .from("ablage_ordner")
      .select("pfad")
      .eq("nas_ausstehend", true)
      .order("pfad")
      .limit(200);
    const ordner = (ausstehend ?? []).map((r) => r.pfad as string);

    // Offene Umbenennungs-Auftraege fuer Bestandsdateien (Migr 278).
    const { data: ren } = await admin
      .from("ablage_renames")
      .select("pfad, neuer_name")
      .order("created_at")
      .limit(200);
    const umbenennungen = (ren ?? []).filter((r) => r.neuer_name && !String(r.neuer_name).includes("/"));

    return NextResponse.json({ success: true, items, ordner, umbenennungen });
  } catch (e) {
    logError("ablage.sync.get", e);
    return NextResponse.json({ success: false, error: "Sync-Liste fehlgeschlagen" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Sync nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => null);
    const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) : [];
    const ordner = Array.isArray(body?.ordner) ? (body.ordner as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) : [];
    const hatUmbenannt = Array.isArray(body?.umbenannt) && body.umbenannt.length > 0;
    if (ids.length === 0 && ordner.length === 0 && !hatUmbenannt) {
      return NextResponse.json({ success: false, error: "ids/ordner/umbenannt fehlt" }, { status: 400 });
    }
    const admin = createAdminClient();
    let bestaetigt = 0;
    if (ids.length > 0) {
      const { data: rows, error } = await admin
        .from("ablage_items")
        .update({ synced_at: new Date().toISOString() })
        .in("id", ids)
        .is("synced_at", null)
        .select("id, storage_path");
      if (error) throw new Error(error.message);
      bestaetigt = (rows ?? []).length;
      const pfade = (rows ?? []).map((r) => r.storage_path).filter(Boolean);
      if (pfade.length > 0) {
        // Uebergabe-Bucket aufraeumen — die Datei liegt jetzt auf dem NAS.
        const { error: remErr } = await admin.storage.from("nas-ablage").remove(pfade);
        if (remErr) logError("ablage.sync.cleanup", remErr, { anzahl: pfade.length });
      }
    }
    if (ordner.length > 0) {
      // Der Client hat diese Ordner physisch angelegt.
      const { error } = await admin
        .from("ablage_ordner")
        .update({ nas_ausstehend: false })
        .in("pfad", ordner)
        .eq("nas_ausstehend", true);
      if (error) throw new Error(error.message);
    }
    // Bestaetigte Umbenennungen: Auftrag abschliessen + Datei-Index
    // sofort nachziehen (der naechste Scan wuerde es auch heilen).
    const umbenannt = Array.isArray(body?.umbenannt)
      ? (body.umbenannt as { pfad?: unknown; neuer_pfad?: unknown }[])
          .map((u) => ({ pfad: String(u?.pfad ?? ""), neuer_pfad: String(u?.neuer_pfad ?? "") }))
          .filter((u) => u.pfad && u.neuer_pfad && !u.neuer_pfad.includes("..") && !u.neuer_pfad.startsWith("/"))
          .slice(0, 200)
      : [];
    for (const u of umbenannt) {
      await admin.from("ablage_renames").delete().eq("pfad", u.pfad);
      const neuerName = u.neuer_pfad.split("/").pop() ?? u.neuer_pfad;
      await admin
        .from("ablage_datei_index")
        .update({ pfad: u.neuer_pfad, name: neuerName, aktualisiert: new Date().toISOString() })
        .eq("pfad", u.pfad);
    }
    return NextResponse.json({ success: true, bestaetigt, ordnerBestaetigt: ordner.length, umbenannt: umbenannt.length });
  } catch (e) {
    logError("ablage.sync.post", e);
    return NextResponse.json({ success: false, error: "Sync-Bestätigung fehlgeschlagen" }, { status: 500 });
  }
}
