import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { timingSafeEqual } from "crypto";

// Datei-Index-Abgleich (Leo 2026-09-30): der NAS-Sync-Client scannt die
// DATEINAMEN der Freigabe (nie Inhalte) und meldet sie chunked hierher —
// damit die Ablage-Suche ALLE Dokumente findet, auch manuell abgelegte.
//
//   POST { scanId, dateien: [{pfad, ordner, name, groesse, geaendert}],
//          fertig: bool }
//   * je Chunk: Upsert (unique pfad), zuletzt gesehener Scan = scanId
//   * fertig=true (letzter Chunk): Zeilen anderer scan_ids loeschen
//     (Datei entfernt/verschoben) — mit Schutzbremse gegen Fehl-Scans.
//
// Auth: gleiches Bearer-Secret wie die uebrigen NAS-Endpunkte.

export const maxDuration = 60;

const MAX_CHUNK = 1000;
const MAX_LAENGE = 400;

function tokenOk(request: NextRequest): boolean | null {
  const secret = process.env.ABLAGE_SYNC_TOKEN;
  if (!secret || secret.length < 32) return null;
  const header = request.headers.get("authorization") ?? "";
  const angeboten = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(angeboten);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function pfadOk(p: string): boolean {
  if (!p || p.length > MAX_LAENGE) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("..")) return false;
  return p.split("/").every((seg) => seg.length > 0 && !/^[@.#]/.test(seg));
}

export async function POST(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => null);
    const scanId = typeof body?.scanId === "string" ? body.scanId.slice(0, 64) : "";
    const fertig = body?.fertig === true;
    const roh = Array.isArray(body?.dateien) ? (body.dateien as Record<string, unknown>[]) : [];
    if (!scanId) return NextResponse.json({ success: false, error: "scanId fehlt" }, { status: 400 });
    if (roh.length > MAX_CHUNK) {
      return NextResponse.json({ success: false, error: `Chunk zu gross (max. ${MAX_CHUNK})` }, { status: 400 });
    }

    const admin = createAdminClient();
    const rows = roh
      .map((d) => ({
        pfad: String(d.pfad ?? "").trim(),
        ordner_pfad: String(d.ordner ?? "").trim(),
        name: String(d.name ?? "").trim().slice(0, 255),
        groesse: typeof d.groesse === "number" && Number.isFinite(d.groesse) ? Math.max(0, Math.round(d.groesse)) : null,
        geaendert: typeof d.geaendert === "string" && !Number.isNaN(Date.parse(d.geaendert)) ? d.geaendert : null,
        scan_id: scanId,
        aktualisiert: new Date().toISOString(),
      }))
      .filter((r) => r.name && pfadOk(r.pfad) && (r.ordner_pfad === "" || pfadOk(r.ordner_pfad)));

    if (rows.length > 0) {
      const { error } = await admin.from("ablage_datei_index").upsert(rows, { onConflict: "pfad" });
      if (error) throw new Error(error.message);
    }

    let entfernt = 0;
    if (fertig) {
      const { count } = await admin.from("ablage_datei_index").select("id", { count: "exact", head: true });
      const { count: alteAnz } = await admin
        .from("ablage_datei_index")
        .select("id", { count: "exact", head: true })
        .neq("scan_id", scanId);
      const total = count ?? 0;
      const alte = alteAnz ?? 0;
      // Schutzbremse wie beim Ordner-Abgleich: ein Scan, der fast alles
      // wegputzen wuerde, ist vermutlich kaputt (Mount weg) — behalten.
      if (total >= 50 && alte > Math.max(50, total * 0.6)) {
        logError("ablage.datei-index.bremse", null, { total, alte, scanId });
      } else if (alte > 0) {
        const { error } = await admin.from("ablage_datei_index").delete().neq("scan_id", scanId);
        if (error) throw new Error(error.message);
        entfernt = alte;
      }
    }

    return NextResponse.json({ success: true, uebernommen: rows.length, entfernt });
  } catch (e) {
    logError("ablage.datei-index", e);
    return NextResponse.json({ success: false, error: "Index-Abgleich fehlgeschlagen" }, { status: 500 });
  }
}
