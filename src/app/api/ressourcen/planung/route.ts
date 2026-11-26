// POST /api/ressourcen/planung — fiktives Personal und Planstellen des
// Planungsbretts (Tabellen planung_fiktives_personal, standort_planstellen,
// Migration 392). Body je nach «aktion»:
//
//   { aktion: "fiktiv-neu", name }                         → { success, id }
//   { aktion: "fiktiv-loeschen", id }                      → { success }
//       (entfernt die Person auch aus allen Häusern)
//   { aktion: "fiktiv-setze", locationId, fiktivId, funktion | null }
//       → { success }  fiktive Person an einer Location in eine Funktion
//         setzen (null = dort entfernen)
//   { aktion: "offen-neu", locationId, funktion }          → { success, id }
//   { aktion: "offen-loeschen", id }                       → { success }
//
// Wer: locations:edit (Admin immer). Schreiben nach der Rechte-Prüfung über
// den Admin-Client (die Tabellen lassen direktes Schreiben nur Admins zu).

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { istFunktion } from "@/lib/ressourcen/funktionen";
import { logError } from "@/lib/log";

function fehler(error: string, status: number) {
  return NextResponse.json({ success: false, error }, { status });
}

/** Tabelle fehlt (Migration 392 nicht eingespielt). */
function tabelleFehlt(e: { code?: string } | null): boolean {
  return !!e && (e.code === "PGRST205" || e.code === "42P01");
}
const MIGRATION = "Fiktives Personal und offene Stellen brauchen die Datenbank-Migration 392, sie ist noch nicht eingespielt";

export async function POST(req: NextRequest) {
  const auth = await requirePermission("locations:edit");
  if (auth.error) return auth.error;

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const aktion = typeof b?.aktion === "string" ? b.aktion : "";
  const text = (k: string) => (typeof b?.[k] === "string" ? (b[k] as string) : "");
  const admin = createAdminClient();

  try {
    if (aktion === "fiktiv-neu") {
      const name = text("name").trim().replace(/\s+/g, " ");
      if (name.length < 1 || name.length > 80) return fehler("Bitte einen Namen mit höchstens 80 Zeichen angeben", 400);
      const { data, error } = await admin.from("planung_fiktives_personal").insert({ name, erstellt_von: auth.user.id }).select("id").single();
      if (tabelleFehlt(error)) return fehler(MIGRATION, 409);
      if (error) throw error;
      return NextResponse.json({ success: true, id: data.id as string });
    }

    if (aktion === "fiktiv-loeschen") {
      const id = text("id").toLowerCase();
      if (!isUuid(id)) return fehler("Ungültige ID", 400);
      const { error } = await admin.from("planung_fiktives_personal").delete().eq("id", id);
      if (tabelleFehlt(error)) return fehler(MIGRATION, 409);
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    if (aktion === "fiktiv-setze") {
      const locationId = text("locationId").toLowerCase();
      const fiktivId = text("fiktivId").toLowerCase();
      const funktion = b?.funktion ?? null;
      if (!isUuid(locationId) || !isUuid(fiktivId)) return fehler("Ungültige ID", 400);
      if (funktion !== null && !istFunktion(funktion)) return fehler("Ungültige Funktion", 400);
      // Erst entfernen, dann neu setzen: so gilt je Location genau ein Eintrag.
      const weg = await admin.from("standort_planstellen").delete().eq("location_id", locationId).eq("fiktiv_id", fiktivId);
      if (tabelleFehlt(weg.error)) return fehler(MIGRATION, 409);
      if (weg.error) throw weg.error;
      if (funktion !== null) {
        const { error } = await admin.from("standort_planstellen").insert({ location_id: locationId, fiktiv_id: fiktivId, funktion, erstellt_von: auth.user.id });
        if (error?.code === "23503") return fehler("Location oder fiktive Person nicht gefunden", 404);
        if (error) throw error;
      }
      return NextResponse.json({ success: true });
    }

    if (aktion === "offen-neu") {
      const locationId = text("locationId").toLowerCase();
      const funktion = b?.funktion;
      if (!isUuid(locationId)) return fehler("Ungültige ID", 400);
      if (!istFunktion(funktion)) return fehler("Ungültige Funktion", 400);
      const { data, error } = await admin
        .from("standort_planstellen")
        .insert({ location_id: locationId, fiktiv_id: null, funktion, erstellt_von: auth.user.id })
        .select("id")
        .single();
      if (tabelleFehlt(error)) return fehler(MIGRATION, 409);
      if (error?.code === "23503") return fehler("Location nicht gefunden", 404);
      if (error) throw error;
      return NextResponse.json({ success: true, id: data.id as string });
    }

    if (aktion === "offen-loeschen") {
      const id = text("id").toLowerCase();
      if (!isUuid(id)) return fehler("Ungültige ID", 400);
      const { error } = await admin.from("standort_planstellen").delete().eq("id", id).is("fiktiv_id", null);
      if (tabelleFehlt(error)) return fehler(MIGRATION, 409);
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    return fehler("Unbekannte Aktion", 400);
  } catch (e) {
    logError("api.ressourcen.planung", e, { aktion });
    return fehler("Die Planung konnte nicht gespeichert werden", 500);
  }
}
