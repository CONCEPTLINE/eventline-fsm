// Lohnausweis (offizielles ESTV-Formular 11) nach Auszahlungsjahr — Phase 4.
//
// GET  /api/hr/lohnausweis?jahr=YYYY&vorlage=1   CSV-Vorlage für die Personalien
//      (je Person mit Abrechnungen im Jahr: profile_id, Name, Geburtsdatum aus
//      dem ERP; AHV-Nr. und Adresse leer — gehören ins Backoffice «Trust flow»)
// POST /api/hr/lohnausweis                       PDF (multipart/form-data):
//      jahr, profile_id? (ohne = alle in einer PDF), personalien? (CSV-Datei)
//
// Die Personalien-CSV wird NUR im Speicher für diesen Druck gelesen — nicht in
// DB oder Speicher abgelegt, nicht protokolliert. Der Lohnausweis wird nur
// heruntergeladen (nicht als Lohndokument gespeichert; ein unterschriebener
// Lohnausweis wird über Lohndokumente hochgeladen = neue Fassung).
// Werte: src/lib/lohn/lohnausweis.ts (Regeln und Herkunft der Vorlage dort).
// Hinweise (fehlende Personalien, gekürzte Felder) im Header X-Lohnausweis-Hinweise
// (URI-kodiertes JSON).
//
// Zugriff: Lohnrecht + vertrautes Gerät; der eigene Lohnausweis nur durch eine
// zweite Person (Vier Augen, wie alle Lohndokumente).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { isUuid } from "@/lib/search-escape";
import { todayLocalIso } from "@/lib/swiss-time";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { EIGENE_DOKUMENTE_VERBOTEN } from "@/lib/lohn/fassung";
import { ladeFirmaStreng } from "@/lib/lohn/abrechnung";
import { ladeName } from "@/lib/lohn/rechte-antraege";
import {
  ausweisWerteFuer,
  fuelleLohnausweis,
  ladeAusweisDaten,
  ladeVorlage,
  lesePersonalien,
  personalienVorlage,
  verbindePdfs,
  type Personalien,
} from "@/lib/lohn/lohnausweis";

const MAX_CSV = 1024 * 1024;
const fehler = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ success: false, error, ...extra }, { status });

function jahrAus(v: unknown): number | null {
  const j = Number(v);
  return Number.isInteger(j) && j >= 2020 && j <= 2100 ? j : null;
}

export async function GET(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const url = new URL(req.url);
  const jahr = jahrAus(url.searchParams.get("jahr"));
  if (!jahr) return fehler("jahr ungültig");
  if (url.searchParams.get("vorlage") !== "1") return fehler("vorlage=1 erwartet");
  await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_EXPORT, geraetHash: await geraetHashAusCookies(), details: { personalien_vorlage: jahr } });
  try {
    const d = await ladeAusweisDaten(createAdminClient(), jahr);
    return new NextResponse(personalienVorlage(d.personen), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="eventline-personalien_${jahr}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return fehler(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fehler("Formular-Daten erwartet");
  }
  const jahr = jahrAus(form.get("jahr"));
  if (!jahr) return fehler("jahr ungültig");
  const pidRoh = form.get("profile_id");
  const profileId = typeof pidRoh === "string" && pidRoh ? pidRoh : null;
  if (profileId && !isUuid(profileId)) return fehler("profile_id ungültig");
  if (profileId === auth.user.id) return fehler(EIGENE_DOKUMENTE_VERBOTEN, 403);

  // Personalien nur im Speicher (nie speichern, nie protokollieren).
  let personalien: Map<string, Personalien> | null = null;
  const datei = form.get("personalien");
  if (datei instanceof File && datei.size > 0) {
    if (datei.size > MAX_CSV) return fehler("Personalien-CSV über 1 MB");
    const r = lesePersonalien(await datei.text());
    if (r.fehler.length > 0) return fehler(`Personalien-CSV: ${r.fehler.join(" · ")}`, 400, { code: "personalien_fehler", fehler: r.fehler });
    personalien = r.daten;
  }

  await protokolliereZugriff({
    actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_EXPORT, zielProfileId: profileId ?? undefined,
    geraetHash: await geraetHashAusCookies(), details: { lohnausweis: jahr, alle: !profileId, mit_personalien: !!personalien },
  });

  const admin = createAdminClient();
  try {
    const [d, vorlage, firma, zustaendig] = await Promise.all([ladeAusweisDaten(admin, jahr), ladeVorlage(), ladeFirmaStreng(admin), ladeName(admin, auth.user.id)]);
    const ids = profileId ? [profileId] : d.personen.map((p) => p.profile_id).filter((id) => id !== auth.user.id);
    const hinweise: string[] = [];
    if (!profileId && d.personen.some((p) => p.profile_id === auth.user.id)) hinweise.push("Eigener Lohnausweis nicht enthalten (Vier Augen)");
    const pdfs: Uint8Array[] = [];
    for (const id of ids) {
      const w = ausweisWerteFuer(d, id);
      if (!w) continue;
      const r = await fuelleLohnausweis(vorlage, w, personalien?.get(id) ?? null, { firma, zustaendig, datum: todayLocalIso() });
      pdfs.push(r.pdf);
      for (const h of r.hinweise) hinweise.push(`${w.name}: ${h}`);
    }
    if (pdfs.length === 0) {
      return fehler(profileId ? `Keine Lohnabrechnungen mit Auszahlung ${jahr} für diese Person` : `Keine Lohnabrechnungen mit Auszahlung ${jahr}`, 404);
    }
    const pdf = pdfs.length === 1 ? pdfs[0] : await verbindePdfs(pdfs);
    const name = profileId ? (d.personen.find((p) => p.profile_id === profileId)?.name ?? "person") : "alle";
    const dateiname = `lohnausweis_${jahr}_${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${dateiname}.pdf"`,
        "Cache-Control": "no-store",
        "X-Lohnausweis-Anzahl": String(pdfs.length),
        "X-Lohnausweis-Hinweise": encodeURIComponent(JSON.stringify(hinweise)),
      },
    });
  } catch (e) {
    return fehler(e instanceof Error ? e.message : String(e), 500);
  }
}
