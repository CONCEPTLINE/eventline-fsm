// POST /api/hr/wage-documents/generate
// Body: { profile_id, year, month, neue_fassung?: boolean, begruendung?: string, auszahlungsdatum?: YYYY-MM-DD }
//
// Phase 2: gerechnet vom Rechenkern, gespeichert als Momentaufnahme, die PDF
// wird daraus gedruckt (src/lib/lohn/abrechnung.ts). Gibt es für den Monat
// schon eine Fassung, entsteht eine KORREKTURFASSUNG: Begründung Pflicht,
// ausbezahlt wird die Differenz am nächsten Auszahlungstag (oder am
// angegebenen auszahlungsdatum).
//
// Erzeugt die PDF-Lohnabrechnung eines Mitarbeiters für einen GESPERRTEN
// Monat (ab dem 5. des Folgemonats) und speichert sie als Fassung
// (src/lib/lohn/abrechnung.ts + fassung.ts):
//   - ungesperrter Monat → 400 (code «nicht_gesperrt»)
//   - es gibt schon eine gültige Fassung und neue_fassung fehlt → 409
//     (code «neue_fassung», die UI fragt nach). Mit neue_fassung=true
//     entsteht Fassung n+1 unter eigenem Pfad; die bisherige bleibt.
//   - jeder Lade-/Speicherfehler → Fehler mit Ursache (nie «0 h = Erfolg»)
//
// Zugriff: Lohnrecht + vertrautes Gerät; nie für sich selbst (Vier Augen).
// Der automatische Lauf ruft diese
// Route NICHT mehr auf (früher mit dem Cron-Geheimnis als Bearer), sondern
// dieselbe Funktion direkt (src/app/api/cron/auto-lohnabrechnung).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { erzeugeUndSpeichereLohnabrechnung } from "@/lib/lohn/abrechnung";
import { LohnFehler, EIGENE_DOKUMENTE_VERBOTEN } from "@/lib/lohn/fassung";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

export const maxDuration = 60;

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Body fehlt" }, { status: 400 });
  const profileId = String(body.profile_id ?? "");
  const year = Number(body.year);
  const month = Number(body.month);
  const neueFassung = body.neue_fassung === true;
  const begruendung = typeof body.begruendung === "string" ? body.begruendung.trim().slice(0, 1000) : null;
  const auszahlungsdatum = typeof body.auszahlungsdatum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.auszahlungsdatum) ? body.auszahlungsdatum : null;
  if (!isUuid(profileId)) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return NextResponse.json({ success: false, error: "year ungültig" }, { status: 400 });
  if (!Number.isInteger(month) || month < 1 || month > 12) return NextResponse.json({ success: false, error: "month ungültig" }, { status: 400 });

  if (profileId === auth.user.id) return NextResponse.json({ success: false, error: EIGENE_DOKUMENTE_VERBOTEN }, { status: 403 });

  const admin = createAdminClient();
  const { data: me, error: meErr } = await admin.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
  if (meErr) return NextResponse.json({ success: false, error: meErr.message }, { status: 500 });

  try {
    const r = await erzeugeUndSpeichereLohnabrechnung(admin, {
      profileId,
      year,
      month,
      actorId: auth.user.id,
      actorName: (me?.full_name as string | null) ?? null,
      neueFassung,
      begruendung,
      auszahlungsdatum,
    });
    return NextResponse.json({
      success: true, mode: r.modus, version: r.version, art: r.art, fassung: r.fassung,
      auszahlung: r.auszahlung, auszahlungsdatum: r.auszahlungsdatum,
    });
  } catch (e) {
    if (e instanceof LohnFehler) {
      if (e.status >= 500) logError("hr.wage-documents.generate", e, { profileId, year, month });
      return NextResponse.json(
        { success: false, error: e.message, ...(e.code === "neue_fassung" || e.code === "begruendung_fehlt" ? { requires_confirm: "neue_fassung" } : {}), code: e.code ?? null },
        { status: e.status },
      );
    }
    logError("hr.wage-documents.generate", e, { profileId, year, month });
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
