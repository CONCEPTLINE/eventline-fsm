// GET/PUT /api/catering/stammdaten — Einstellungen und Getränkekarte des Getränke-Caterings
// (Einstellungen → Catering). Nur Admins (Einkaufspreise und Personalkosten sind intern).
//
//   GET → { einstellungen, karte[] }   (karte inkl. inaktiver Zeilen)
//   PUT { einstellungen, karte[] }     prüft (lib/catering/pruefen.ts), speichert die Einstellungen und gleicht
//       die Karte ab: Zeilen mit id werden aktualisiert, ohne id neu angelegt, in der DB vorhandene aber nicht
//       mehr gesendete werden gelöscht. Bereits gespeicherte Kalkulationen (job_catering.ergebnis) bleiben
//       unverändert — der Auftrags-Reiter weist auf Abweichungen hin.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { pruefeStammdaten, type EinstellungenEingabe, type KartenEingabe } from "@/lib/catering/pruefen";

const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const admin = createAdminClient();
    const [e, k] = await Promise.all([
      admin.from("catering_einstellungen").select("*").eq("id", true).maybeSingle(),
      admin.from("catering_getraenke").select("id, kategorie, name, einheit, verkauf, einkauf, mix_anteil, aktiv, sort").order("sort"),
    ]);
    if (e.error) throw e.error;
    if (k.error) throw k.error;
    const d = e.data;
    return NextResponse.json({
      success: true,
      einstellungen: {
        lohnProStunde: Number(d?.lohn_pro_stunde ?? 32), gaesteProKraft: Number(d?.gaeste_pro_kraft ?? 50),
        puffer: Number(d?.puffer ?? 0.1), aufschlagA: Number(d?.aufschlag_a ?? 0.1),
        anteilVor: Number(d?.anteil_vor ?? 0.85), rateVor: Number(d?.rate_vor ?? 1.2),
        anteilPause: Number(d?.anteil_pause ?? 0.9), ratePause: Number(d?.rate_pause ?? 3),
        anteilNach: Number(d?.anteil_nach ?? 0.65), rateNach: Number(d?.rate_nach ?? 1.2),
      } satisfies EinstellungenEingabe,
      karte: (k.data ?? []).map((z) => ({
        id: z.id as string, kategorie: z.kategorie as string, name: z.name as string, einheit: (z.einheit as string) ?? "",
        verkauf: Number(z.verkauf), einkauf: Number(z.einkauf), mixAnteil: z.mix_anteil == null ? null : Number(z.mix_anteil), aktiv: z.aktiv as boolean,
      })) satisfies KartenEingabe[],
    });
  } catch (err) {
    logError("catering.stammdaten.laden", err);
    return fehler("Laden fehlgeschlagen", 500);
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  let b: { einstellungen?: EinstellungenEingabe; karte?: KartenEingabe[] };
  try {
    b = await req.json();
  } catch {
    return fehler("Ungültige Anfrage");
  }
  if (!b.einstellungen || !Array.isArray(b.karte)) return fehler("Einstellungen und Karte fehlen");
  const meldung = pruefeStammdaten(b.einstellungen, b.karte);
  if (meldung) return fehler(meldung, 422);

  try {
    const admin = createAdminClient();
    const e = b.einstellungen;
    const { error: eErr } = await admin.from("catering_einstellungen").upsert({
      id: true, lohn_pro_stunde: e.lohnProStunde, gaeste_pro_kraft: e.gaesteProKraft, puffer: e.puffer, aufschlag_a: e.aufschlagA,
      anteil_vor: e.anteilVor, rate_vor: e.rateVor, anteil_pause: e.anteilPause, rate_pause: e.ratePause,
      anteil_nach: e.anteilNach, rate_nach: e.rateNach, updated_at: new Date().toISOString(),
    });
    if (eErr) throw eErr;

    const { data: vorhanden, error: vErr } = await admin.from("catering_getraenke").select("id");
    if (vErr) throw vErr;
    const gesendeteIds = new Set(b.karte.filter((z) => z.id).map((z) => z.id as string));
    const loeschen = (vorhanden ?? []).map((z) => z.id as string).filter((id) => !gesendeteIds.has(id));

    for (const [i, z] of b.karte.entries()) {
      const zeile = {
        kategorie: z.kategorie, name: z.name.trim(), einheit: z.einheit.trim(), verkauf: z.verkauf, einkauf: z.einkauf,
        mix_anteil: z.mixAnteil, aktiv: z.aktiv, sort: (i + 1) * 10, updated_at: new Date().toISOString(),
      };
      if (z.id) {
        const { error } = await admin.from("catering_getraenke").update(zeile).eq("id", z.id);
        if (error) throw error;
      } else {
        const { error } = await admin.from("catering_getraenke").insert(zeile);
        if (error) throw error;
      }
    }
    if (loeschen.length) {
      const { error } = await admin.from("catering_getraenke").delete().in("id", loeschen);
      if (error) throw error;
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    logError("catering.stammdaten.speichern", err);
    return fehler("Speichern fehlgeschlagen", 500);
  }
}
