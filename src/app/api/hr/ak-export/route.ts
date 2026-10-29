// Export Lohnbescheinigung AK 40 (Ausgleichskasse) — Phase 4.
//
// POST /api/hr/ak-export (multipart/form-data): jahr, personalien? (CSV-Datei)
//   → CSV (Trenner «;», UTF-8 mit BOM — Excel öffnet sie direkt): je Person
//     AHV-Nr., Name, Geburtsdatum, Beschäftigt von–bis (im Jahr), AHV-Lohn,
//     davon beitragsfrei (2'500-Grenze, Art. 34d AHVV), AHV-pflichtig, ALV-Lohn.
// Basis: Jahresliste nach Auszahlungsjahr (AHV: Lohn zählt im Jahr der
// Auszahlung). AHV-Nr. aus der optionalen Personalien-CSV (nur im Speicher,
// nie gespeichert), sonst leer.
//
// Zugriff: Lohnrecht + vertrautes Gerät.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ak40Csv, ak40Zeilen, ladeAusweisDaten, lesePersonalien, type Personalien } from "@/lib/lohn/lohnausweis";

const MAX_CSV = 1024 * 1024;
const fehler = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ success: false, error, ...extra }, { status });

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fehler("Formular-Daten erwartet");
  }
  const jahr = Number(form.get("jahr"));
  if (!Number.isInteger(jahr) || jahr < 2020 || jahr > 2100) return fehler("jahr ungültig");

  let personalien: Map<string, Personalien> | null = null;
  const datei = form.get("personalien");
  if (datei instanceof File && datei.size > 0) {
    if (datei.size > MAX_CSV) return fehler("Personalien-CSV über 1 MB");
    const r = lesePersonalien(await datei.text());
    if (r.fehler.length > 0) return fehler(`Personalien-CSV: ${r.fehler.join(" · ")}`, 400, { code: "personalien_fehler", fehler: r.fehler });
    personalien = r.daten;
  }
  await protokolliereZugriff({
    actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_EXPORT, geraetHash: await geraetHashAusCookies(),
    details: { ak40: jahr, mit_personalien: !!personalien },
  });
  try {
    const d = await ladeAusweisDaten(createAdminClient(), jahr);
    if (d.personen.length === 0) return fehler(`Keine Lohnabrechnungen mit Auszahlung ${jahr}`, 404);
    return new NextResponse(ak40Csv(jahr, ak40Zeilen(d, personalien)), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="eventline-lohnbescheinigung-ak40_${jahr}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return fehler(e instanceof Error ? e.message : String(e), 500);
  }
}
