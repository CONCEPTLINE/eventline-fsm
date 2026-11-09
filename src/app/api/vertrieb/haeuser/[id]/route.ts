// POST /api/vertrieb/haeuser/<id>  (vertrieb:edit)
//
// Aktionen am Haus, die mehr als ein Feld ändern und darum zusammen in den
// Verlauf gehören (Vertrieb neu, Leo 09.11.2026):
//   { aktion: "stufe", stufe }            → Stufe setzen + Verlaufseintrag
//   { aktion: "anruf", ergebnis, notiz? } → Verlauf + Stufe + nächster Schritt
//   { aktion: "notiz", text }             → nur Verlaufseintrag
// Einfache Felder (Kontakt, Bedarf, Datum/Aufgabe) speichert das Profil
// direkt über Supabase (RLS vertrieb:edit), wie bisher die Räume.

import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { todayLocalIso } from "@/lib/swiss-time";
import { ALLE_STUFEN, anrufFolgen, istAnrufErgebnis, stufeInfo } from "@/lib/vertrieb/haeuser";
import type { HausStufe } from "@/types/vertrieb";

export const dynamic = "force-dynamic";

const TEXT_MAX = 2000;

function fehler(text: string, status = 400) {
  return NextResponse.json({ ok: false, error: text }, { status });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return fehler("Ungültige Haus-ID");

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const aktion = body?.aktion;
  const admin = createAdminClient();

  const { data: haus, error: hausFehler } = await admin
    .from("vertrieb_raeume").select("id, stufe").eq("id", id).maybeSingle();
  if (hausFehler) return fehler(hausFehler.message, 500);
  if (!haus) return fehler("Haus nicht gefunden", 404);
  const vorher = haus.stufe as HausStufe;
  const heute = todayLocalIso();

  const verlauf = (titel: string, text: string | null, art: string, ton: string | null) =>
    admin.from("vertrieb_haus_verlauf").insert({ haus_id: id, datum: heute, art, titel, text, ton, erstellt_von: auth.effectiveUserId });

  if (aktion === "stufe") {
    const stufe = body?.stufe;
    if (!ALLE_STUFEN.some((s) => s.key === stufe)) return fehler("Ungültige Stufe");
    if (stufe === vorher) return NextResponse.json({ ok: true });
    const { error } = await admin.from("vertrieb_raeume").update({ stufe }).eq("id", id);
    if (error) return fehler(error.message, 500);
    const v = await verlauf(`Stufe: ${stufeInfo(stufe as HausStufe).label}`, `vorher ${stufeInfo(vorher).label}`, "stufe", null);
    if (v.error) return fehler(`Stufe gespeichert, Verlauf nicht: ${v.error.message}`, 500);
    return NextResponse.json({ ok: true });
  }

  if (aktion === "anruf") {
    const ergebnis = body?.ergebnis;
    if (!istAnrufErgebnis(ergebnis)) return fehler("Ungültiges Ergebnis");
    const notiz = typeof body?.notiz === "string" ? body.notiz.trim().slice(0, TEXT_MAX) : "";
    const f = anrufFolgen(ergebnis, heute, vorher);
    const { error } = await admin.from("vertrieb_raeume")
      .update({ stufe: f.stufe, datum: f.datum, aufgabe: f.aufgabe }).eq("id", id);
    if (error) return fehler(error.message, 500);
    const v = await verlauf(f.titel, notiz || f.text, "anruf", f.ton);
    if (v.error) return fehler(`Anruf gespeichert, Verlauf nicht: ${v.error.message}`, 500);
    return NextResponse.json({ ok: true });
  }

  if (aktion === "notiz") {
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, TEXT_MAX) : "";
    if (!text) return fehler("Notiz ist leer");
    const v = await verlauf("Notiz", text, "notiz", null);
    if (v.error) return fehler(v.error.message, 500);
    return NextResponse.json({ ok: true });
  }

  return fehler("Unbekannte Aktion");
}
