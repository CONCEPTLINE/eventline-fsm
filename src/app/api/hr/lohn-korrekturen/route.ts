// Korrektur-Vorschläge und Korrekturfassungen (Phase 2).
//
// GET  /api/hr/lohn-korrekturen?jahr=YYYY     — Vorschläge des Jahres (offen zuerst)
// POST /api/hr/lohn-korrekturen
//   { aktion: "nachrechnen", jahr, profile_id? }  Kern rechnet alle Monate mit gültiger
//        Fassung neu (Sätze der ursprünglichen Auszahlung) → Vorschlag je Abweichung
//   { aktion: "erstellen", id, begruendung, auszahlungsdatum? }  Korrekturfassung:
//        ersetzt den Monat, ausbezahlt wird die Differenz (nächster Auszahlungstag
//        oder auszahlungsdatum)
//   { aktion: "verwerfen", id }
//
// Zugriff: Lohnrecht + vertrautes Gerät; eigene Abrechnungen nie (Vier Augen).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ladeName } from "@/lib/lohn/rechte-antraege";
import { EIGENE_DOKUMENTE_VERBOTEN, LohnFehler } from "@/lib/lohn/fassung";
import { erzeugeUndSpeichereLohnabrechnung } from "@/lib/lohn/abrechnung";
import { erstelleKorrekturVorschlaege } from "@/lib/lohn/aenderungen";

export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const jahrParam = new URL(req.url).searchParams.get("jahr") ?? "";
  const jahr = /^\d{4}$/.test(jahrParam) ? Number(jahrParam) : new Date().getFullYear();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("lohn_korrektur_vorschlaege")
    .select("id, profile_id, jahr, monat, antrag_id, vorfassung_id, brutto_alt, brutto_neu, netto_alt, netto_neu, differenz, status, erstellt_at, erledigt_at, erledigt_von_name, momentaufnahme_id")
    .eq("jahr", jahr)
    .order("status")
    .order("monat")
    .limit(1000);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  const ids = Array.from(new Set((data ?? []).map((v) => v.profile_id as string)));
  const namen = new Map<string, string>();
  if (ids.length) {
    const { data: p, error: pe } = await admin.from("profiles").select("id, full_name").in("id", ids);
    if (pe) return NextResponse.json({ success: false, error: pe.message }, { status: 500 });
    for (const r of p ?? []) namen.set(r.id as string, (r.full_name as string) ?? "?");
  }
  return NextResponse.json({ success: true, jahr, vorschlaege: (data ?? []).map((v) => ({ ...v, name: namen.get(v.profile_id as string) ?? "?" })) });
}

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const aktion = body?.aktion;
  const admin = createAdminClient();
  try {
    if (aktion === "nachrechnen") {
      const jahr = Number(body?.jahr);
      if (!Number.isInteger(jahr) || jahr < 2020 || jahr > 2100) return NextResponse.json({ success: false, error: "jahr ungültig" }, { status: 400 });
      const pid = typeof body?.profile_id === "string" && isUuid(body.profile_id) ? body.profile_id : null;
      const r = await erstelleKorrekturVorschlaege(admin, { jahr, profileIds: pid ? [pid] : null });
      return NextResponse.json({ success: true, ...r });
    }
    const id = typeof body?.id === "string" && isUuid(body.id) ? body.id : null;
    if (!id) return NextResponse.json({ success: false, error: "id fehlt" }, { status: 400 });
    const { data: v, error } = await admin.from("lohn_korrektur_vorschlaege").select("id, profile_id, jahr, monat, status").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!v || v.status !== "offen") return NextResponse.json({ success: false, error: "Vorschlag nicht (mehr) offen" }, { status: 409 });
    const name = await ladeName(admin, auth.user.id);
    if (aktion === "verwerfen") {
      const { error: e } = await admin.from("lohn_korrektur_vorschlaege")
        .update({ status: "verworfen", erledigt_at: new Date().toISOString(), erledigt_von: auth.user.id, erledigt_von_name: name }).eq("id", id).eq("status", "offen");
      if (e) throw new Error(e.message);
      return NextResponse.json({ success: true });
    }
    if (aktion !== "erstellen") return NextResponse.json({ success: false, error: "aktion unbekannt" }, { status: 400 });
    if (v.profile_id === auth.user.id) return NextResponse.json({ success: false, error: EIGENE_DOKUMENTE_VERBOTEN }, { status: 403 });
    const datum = typeof body?.auszahlungsdatum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.auszahlungsdatum) ? body.auszahlungsdatum : null;
    const r = await erzeugeUndSpeichereLohnabrechnung(admin, {
      profileId: v.profile_id as string,
      year: v.jahr as number,
      month: v.monat as number,
      actorId: auth.user.id,
      actorName: name,
      neueFassung: true,
      begruendung: typeof body?.begruendung === "string" ? body.begruendung.trim().slice(0, 1000) : null,
      auszahlungsdatum: datum,
    });
    const { error: e } = await admin.from("lohn_korrektur_vorschlaege")
      .update({ status: "erledigt", erledigt_at: new Date().toISOString(), erledigt_von: auth.user.id, erledigt_von_name: name, momentaufnahme_id: r.momentaufnahmeId })
      .eq("id", id);
    if (e) throw new Error(`Korrekturfassung erstellt, Vorschlag aber nicht abgeschlossen: ${e.message}`);
    return NextResponse.json({ success: true, fassung: r.fassung, auszahlung: r.auszahlung, auszahlungsdatum: r.auszahlungsdatum });
  } catch (e) {
    if (e instanceof LohnFehler) return NextResponse.json({ success: false, error: e.message, code: e.code ?? null }, { status: e.status });
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
