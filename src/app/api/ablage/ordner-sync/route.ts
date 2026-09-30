import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { timingSafeEqual } from "crypto";

// Ordnerstruktur-Abgleich: der NAS-Sync-Client scannt die echte
// UGREEN-Ordnerstruktur und spiegelt sie hierher (Leo 2026-09-29:
// "kann das NAS nicht die Ordnerstruktur ins FSM pumpen?").
// Die Liste ERSETZT den Bestand in ablage_ordner vollstaendig —
// das NAS ist die Wahrheit. WICHTIG: bestehende Zeilen werden nie
// angefasst (nur neue eingefuegt, entfallene geloescht) — das
// aktiv-Flag (Ordner-Deaktivierung, Migration 275) ueberlebt so
// jedes Struktur-Update.
//
// Auth: gleiches Bearer-Secret wie die uebrigen NAS-Endpunkte.

const MAX_PFADE = 3000;
const MAX_LAENGE = 190;

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

/** Defense in depth — der Client filtert schon, der Server nochmal. */
function pfadOk(p: string): boolean {
  if (!p || p.length > MAX_LAENGE) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("..")) return false;
  // Versteckte/System-Segmente (@appdata, .recycle, #snapshot, …)
  return p.split("/").every((seg) => seg.length > 0 && !/^[@.#]/.test(seg));
}

export async function POST(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => null);
    const roh = Array.isArray(body?.pfade) ? (body.pfade as unknown[]) : null;
    if (!roh) return NextResponse.json({ success: false, error: "pfade fehlt" }, { status: 400 });
    if (roh.length > MAX_PFADE) {
      return NextResponse.json({ success: false, error: `Zu viele Pfade (max. ${MAX_PFADE}) — Scan-Ausschlüsse/-Tiefe auf dem NAS anpassen` }, { status: 400 });
    }
    const pfade = Array.from(new Set(
      roh.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(pfadOk),
    ));
    if (pfade.length === 0) {
      // Leerer Scan waere destruktiv (wuerde die ganze Auswahl loeschen) —
      // vermutlich Mount-Problem auf dem NAS. Nicht anwenden.
      return NextResponse.json({ success: false, error: "Leere Ordnerliste — nicht angewendet" }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: bestand, error: selErr } = await admin.from("ablage_ordner").select("pfad, nas_ausstehend");
    if (selErr) throw new Error(selErr.message);
    const alt = new Set((bestand ?? []).map((r) => r.pfad as string));
    // Im FSM angelegte, noch nicht auf dem NAS erstellte Ordner fehlen im
    // Scan zwangslaeufig — die darf der Abgleich NICHT loeschen.
    const ausstehend = new Set((bestand ?? []).filter((r) => r.nas_ausstehend).map((r) => r.pfad as string));
    const neu = pfade.filter((p) => !alt.has(p));
    const weg = [...alt].filter((p) => !pfade.includes(p) && !ausstehend.has(p));
    // Taucht ein ausstehender Ordner im Scan auf, ist er angelegt -> abhaken.
    const jetztDa = pfade.filter((p) => ausstehend.has(p));

    // Schutzbremse: ein Abgleich, der einen grossen Bestand fast komplett
    // wegputzen wuerde, ist mit hoher Wahrscheinlichkeit ein Fehl-Scan
    // (Mount weg, falscher NAS_BASIS o.ae.) — nicht anwenden. Vorfall
    // 2026-09-29: ein Teil-Scan haette 164 gepflegte Ordner geloescht.
    if (alt.size >= 20 && weg.length > Math.max(20, alt.size * 0.6)) {
      logError("ablage.ordner-sync.bremse", null, { bestand: alt.size, entfernt: weg.length, gemeldet: pfade.length });
      return NextResponse.json(
        { success: false, error: `Abgleich würde ${weg.length} von ${alt.size} Ordnern entfernen — als Fehl-Scan verworfen (Mount/NAS_BASIS auf dem NAS prüfen)` },
        { status: 409 },
      );
    }

    if (neu.length > 0) {
      const { error } = await admin.from("ablage_ordner").insert(neu.map((pfad) => ({ pfad })));
      if (error) throw new Error(error.message);
    }
    if (weg.length > 0) {
      const { error } = await admin.from("ablage_ordner").delete().in("pfad", weg);
      if (error) throw new Error(error.message);
    }
    if (jetztDa.length > 0) {
      const { error } = await admin.from("ablage_ordner").update({ nas_ausstehend: false }).in("pfad", jetztDa);
      if (error) throw new Error(error.message);
    }
    return NextResponse.json({ success: true, total: pfade.length, neu: neu.length, entfernt: weg.length });
  } catch (e) {
    logError("ablage.ordner-sync", e);
    return NextResponse.json({ success: false, error: "Abgleich fehlgeschlagen" }, { status: 500 });
  }
}
