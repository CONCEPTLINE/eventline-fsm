// GET/PUT /api/catering/stammdaten — Einstellungen und Getränkekarte des Getränke-Caterings
// (Einstellungen → Catering). Nur Admins (Einkaufspreise und Personalkosten sind intern).
//
//   GET → { einstellungen, karte[] }   (karte inkl. inaktiver Zeilen)
//   PUT { einstellungen, karte[] }     prüft (lib/catering/pruefen.ts) und speichert Einstellungen und Karte in einer
//       Transaktion (SQL-Funktion catering_stammdaten_speichern, Migration 374): Zeilen mit id werden aktualisiert,
//       ohne id neu angelegt, in der DB vorhandene aber nicht mehr gesendete gelöscht. Bereits gespeicherte Kalkulationen (job_catering.ergebnis) bleiben
//       unverändert — der Auftrags-Reiter weist auf Abweichungen hin.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { fehler } from "@/lib/catering/route-hilfen";
import { pruefeStammdaten, type EinstellungenEingabe, type KartenEingabe } from "@/lib/catering/pruefen";

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const admin = createAdminClient();
    const [e, k] = await Promise.all([
      admin.from("catering_einstellungen").select("*").eq("id", true).maybeSingle(),
      admin.from("catering_getraenke").select("id, kategorie, name, einheit, verkauf, einkauf, mix_anteil, gebinde_stueck, gebinde_name, aktiv, sort").order("sort"),
    ]);
    if (e.error) throw e.error;
    if (k.error) throw k.error;
    const d = e.data;
    return NextResponse.json({
      success: true,
      einstellungen: {
        lohnProStunde: Number(d?.lohn_pro_stunde ?? 32), gaesteProKraft: Number(d?.gaeste_pro_kraft ?? 50),
        puffer: Number(d?.puffer ?? 0.1), stundensatzA: Number(d?.stundensatz_a ?? 45),
        anteilVor: Number(d?.anteil_vor ?? 0.85), rateVor: Number(d?.rate_vor ?? 1.2),
        anteilPause: Number(d?.anteil_pause ?? 0.9), ratePause: Number(d?.rate_pause ?? 3),
        anteilNach: Number(d?.anteil_nach ?? 0.65), rateNach: Number(d?.rate_nach ?? 1.2),
      } satisfies EinstellungenEingabe,
      karte: (k.data ?? []).map((z) => ({
        id: z.id as string, kategorie: z.kategorie as string, name: z.name as string, einheit: (z.einheit as string) ?? "",
        verkauf: Number(z.verkauf), einkauf: Number(z.einkauf), mixAnteil: z.mix_anteil == null ? null : Number(z.mix_anteil),
        gebindeStueck: z.gebinde_stueck == null ? null : Number(z.gebinde_stueck), gebindeName: (z.gebinde_name as string | null) ?? null, aktiv: z.aktiv as boolean,
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
  let meldung: string | null;
  try {
    meldung = pruefeStammdaten(b.einstellungen, b.karte);
  } catch {
    return fehler("Ungültige Eingabe", 422);
  }
  if (meldung) return fehler(meldung, 422);

  try {
    // Alles in EINER Transaktion (Migration 374): entweder sind Einstellungen und Karte neu gespeichert oder nichts.
    const admin = createAdminClient();
    const { error } = await admin.rpc("catering_stammdaten_speichern", {
      p_einstellungen: b.einstellungen,
      p_karte: b.karte.map((z, i) => ({ ...z, sort: (i + 1) * 10 })),
    });
    if (error) {
      if (/existiert nicht mehr/.test(error.message)) return fehler("Ein Getränk wurde inzwischen gelöscht. Bitte die Seite neu laden.", 409);
      throw error;
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    logError("catering.stammdaten.speichern", err);
    return fehler("Speichern fehlgeschlagen", 500);
  }
}
