// POST /api/ressourcen/einteilung
//   { locationId, profileId, funktion: "leitung" | "personal" | null }
//   → { success } — setzt EINE Person an EINER Location in eine Funktion
//   (null = Einteilung entfernen). Ressourcen › Planungsbrett.
//
// Wer: locations:edit (Admin immer). Schreiben nach der Rechte-Prüfung über
// den Admin-Client: die Tabelle standort_mitarbeiter lässt direktes Schreiben
// nur Admins zu (RLS, Migration 384), dieser Serverweg ist das Tor.
// Die Spalte «funktion» kommt mit Migration 392. Fehlt sie noch, geht
// «personal» wie bisher, «leitung» wird mit einer klaren Meldung abgelehnt.

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { aktivePersonen } from "@/lib/standort-verfuegbarkeit";
import { logError } from "@/lib/log";

function fehler(error: string, status: number) {
  return NextResponse.json({ success: false, error }, { status });
}

/** PostgREST/Postgres melden eine unbekannte Spalte so. */
function spalteFehlt(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === "PGRST204" || e.code === "42703") && (e.message ?? "").includes("funktion");
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission("locations:edit");
  if (auth.error) return auth.error;

  const body = (await req.json().catch(() => null)) as { locationId?: unknown; profileId?: unknown; funktion?: unknown } | null;
  const locationId = typeof body?.locationId === "string" ? body.locationId.toLowerCase() : "";
  const profileId = typeof body?.profileId === "string" ? body.profileId.toLowerCase() : "";
  const funktion = body?.funktion ?? null;
  if (!isUuid(locationId) || !isUuid(profileId)) return fehler("Ungültige ID", 400);
  if (funktion !== null && funktion !== "leitung" && funktion !== "personal") return fehler("Ungültige Funktion", 400);

  const admin = createAdminClient();
  try {
    if (funktion === null) {
      const { error } = await admin.from("standort_mitarbeiter").delete().eq("location_id", locationId).eq("profile_id", profileId);
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    const { data: loc, error: lErr } = await admin.from("locations").select("id, archived_at").eq("id", locationId).maybeSingle();
    if (lErr) throw lErr;
    if (!loc) return fehler("Location nicht gefunden", 404);
    if (loc.archived_at) return fehler("Archivierte Locations lassen sich nicht ändern", 400);

    const { data: vorhanden, error: vErr } = await admin
      .from("standort_mitarbeiter")
      .select("profile_id")
      .eq("location_id", locationId)
      .eq("profile_id", profileId)
      .maybeSingle();
    if (vErr) throw vErr;
    // Neu eingeteilt wird nur, wer ein aktives internes Konto hat.
    if (!vorhanden && (await aktivePersonen(admin, [profileId])).length === 0) {
      return fehler("Nur aktive EVENTLINE-Mitarbeitende können eingeteilt werden", 400);
    }

    const mit = await admin
      .from("standort_mitarbeiter")
      .upsert({ location_id: locationId, profile_id: profileId, funktion, erstellt_von: auth.user.id }, { onConflict: "location_id,profile_id" });
    if (!mit.error) return NextResponse.json({ success: true });
    if (!spalteFehlt(mit.error)) throw mit.error;

    if (funktion === "leitung") {
      return fehler("Die Funktion «Leitung» braucht die Datenbank-Migration 392, sie ist noch nicht eingespielt", 409);
    }
    const ohne = await admin
      .from("standort_mitarbeiter")
      .upsert({ location_id: locationId, profile_id: profileId, erstellt_von: auth.user.id }, { onConflict: "location_id,profile_id", ignoreDuplicates: true });
    if (ohne.error) throw ohne.error;
    return NextResponse.json({ success: true });
  } catch (e) {
    logError("api.ressourcen.einteilung", e, { locationId, profileId });
    return fehler("Die Einteilung konnte nicht gespeichert werden", 500);
  }
}
