// GET /api/hr/jahresliste?jahr=YYYY&basis=auszahlung|arbeit[&format=xlsx]
//
// Jahresliste je Person und Lohnmonat (Phase 2, erweitert Phase 4): AHV-Lohn,
// davon beitragsfrei (2'500-Grenze, Art. 34d AHVV), ALV-Lohn bis Höchstgrenze,
// UVG-Lohn nur BU bzw. BU+NBU, Quellensteuer, Lohnperiode — mit Arbeits- und
// Auszahlungsjahr; dazu die Werte des Lohnausweises: steuerbarer Lohn,
// steuerbare Zusatzposten (Ziff. 7), Beiträge AHV/IV/EO/ALV/NBU netto
// (Ziff. 9), BVG (Ziff. 10.1), Spesen (Ziff. 13), Auszahlung.
// Grundlage: die Momentaufnahmen (je Monat zählt nur die letzte Fassung,
// Korrektur-Differenzen im Jahr ihrer Auszahlung). Seitenweise geladen
// (daten.ts ladeJahreslisteDaten). Lohnausweis-PDF: /api/hr/lohnausweis,
// Lohnbescheinigung AK 40: /api/hr/ak-export.
//
// Zugriff: Lohnrecht + vertrautes Gerät.

import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ladeJahreslisteDaten } from "@/lib/lohn/daten";
import { jahresliste } from "@/lib/lohn/jahresliste";
import { summeChf } from "@/lib/lohn/kern";

const SUMMEN_SCHLUESSEL = [
  "ahv_lohn", "ahv_beitragsfrei", "alv_lohn", "uvg_lohn_nur_bu", "uvg_lohn_bu_nbu", "quellensteuer", "brutto", "netto",
  "steuerbar", "zusatz_steuerbar", "spesen", "auszahlungsbetrag", "abzug_ahv_iv_eo", "abzug_alv", "abzug_nbu", "abzug_bvg", "abzug_ktg",
] as const;

export async function GET(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const url = new URL(req.url);
  const jahr = Number(url.searchParams.get("jahr"));
  const basis = url.searchParams.get("basis") === "arbeit" ? "arbeit" : "auszahlung";
  if (!Number.isInteger(jahr) || jahr < 2020 || jahr > 2100) return NextResponse.json({ success: false, error: "jahr ungültig" }, { status: 400 });
  await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_EXPORT, geraetHash: await geraetHashAusCookies(), details: { jahresliste: jahr, basis } });

  const admin = createAdminClient();
  try {
    const { fassungen, namen, ahvVerlangt } = await ladeJahreslisteDaten(admin, jahr);
    const zeilen = jahresliste(fassungen, { jahr, basis, ahvVerlangt })
      .map((z) => ({ ...z, name: namen.get(z.profile_id) ?? "?" }))
      .sort((a, b) => a.name.localeCompare(b.name, "de-CH") || a.arbeitsjahr - b.arbeitsjahr || a.monat - b.monat);

    // Summen je Person (Lohnbescheinigung, Lohnausweis)
    type Summe = Record<(typeof SUMMEN_SCHLUESSEL)[number], number> & { name: string; von: string | null; bis: string | null };
    const summen = new Map<string, Summe>();
    for (const z of zeilen) {
      const s: Summe = summen.get(z.profile_id) ?? {
        name: z.name, von: null, bis: null,
        ...(Object.fromEntries(SUMMEN_SCHLUESSEL.map((k) => [k, 0])) as Record<(typeof SUMMEN_SCHLUESSEL)[number], number>),
      };
      for (const k of SUMMEN_SCHLUESSEL) s[k] = summeChf([s[k], z[k]]);
      if (z.lohnperiode_von && (!s.von || z.lohnperiode_von < s.von)) s.von = z.lohnperiode_von;
      if (z.lohnperiode_bis && (!s.bis || z.lohnperiode_bis > s.bis)) s.bis = z.lohnperiode_bis;
      summen.set(z.profile_id, s);
    }

    if (url.searchParams.get("format") !== "xlsx") {
      return NextResponse.json({ success: true, jahr, basis, zeilen, summen: Array.from(summen, ([profile_id, s]) => ({ profile_id, ...s })) });
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = "EVENTLINE FSM";
    const blatt = wb.addWorksheet(`Jahresliste ${jahr}`);
    blatt.columns = [
      { header: "Person", key: "name", width: 24 }, { header: "Arbeitsjahr", key: "arbeitsjahr", width: 11 }, { header: "Monat", key: "monat", width: 7 },
      { header: "Auszahlungsjahr", key: "auszahlungsjahr", width: 15 }, { header: "Auszahlungen", key: "daten", width: 24 }, { header: "Fassung", key: "fassung", width: 8 },
      { header: "Lohnperiode von", key: "lohnperiode_von", width: 14 }, { header: "bis", key: "lohnperiode_bis", width: 12 },
      { header: "Brutto", key: "brutto", width: 11 }, { header: "AHV-Lohn", key: "ahv_lohn", width: 11 }, { header: "davon beitragsfrei (2'500)", key: "ahv_beitragsfrei", width: 22 },
      { header: "ALV-Lohn", key: "alv_lohn", width: 11 }, { header: "UVG-Lohn nur BU", key: "uvg_lohn_nur_bu", width: 15 }, { header: "UVG-Lohn BU+NBU", key: "uvg_lohn_bu_nbu", width: 16 },
      { header: "Quellensteuer", key: "quellensteuer", width: 13 }, { header: "Netto", key: "netto", width: 11 },
      { header: "Steuerbarer Lohn", key: "steuerbar", width: 15 }, { header: "davon Zusatzposten (Ziff. 7)", key: "zusatz_steuerbar", width: 24 },
      { header: "Zusatzposten", key: "zusatz_texte_t", width: 28 },
      { header: "AHV/IV/EO", key: "abzug_ahv_iv_eo", width: 11 }, { header: "ALV", key: "abzug_alv", width: 9 }, { header: "NBU", key: "abzug_nbu", width: 9 },
      { header: "BVG", key: "abzug_bvg", width: 9 }, { header: "KTG", key: "abzug_ktg", width: 9 },
      { header: "Spesen", key: "spesen", width: 10 }, { header: "Auszahlung", key: "auszahlungsbetrag", width: 12 },
    ];
    blatt.getRow(1).font = { bold: true };
    for (const z of zeilen) blatt.addRow({ ...z, daten: z.auszahlungsdaten.join(", "), zusatz_texte_t: [...z.zusatz_texte, ...z.spesen_texte].join("; ") });
    const s = wb.addWorksheet("Summen je Person");
    s.columns = [
      { header: "Person", key: "name", width: 24 }, { header: "Lohnperiode von", key: "von", width: 14 }, { header: "bis", key: "bis", width: 12 },
      { header: "AHV-Lohn", key: "ahv_lohn", width: 11 }, { header: "davon beitragsfrei", key: "ahv_beitragsfrei", width: 17 }, { header: "ALV-Lohn", key: "alv_lohn", width: 11 },
      { header: "UVG nur BU", key: "uvg_lohn_nur_bu", width: 12 }, { header: "UVG BU+NBU", key: "uvg_lohn_bu_nbu", width: 12 }, { header: "Quellensteuer", key: "quellensteuer", width: 13 },
      { header: "Brutto", key: "brutto", width: 11 }, { header: "Netto", key: "netto", width: 11 },
      { header: "Steuerbarer Lohn", key: "steuerbar", width: 15 }, { header: "davon Zusatzposten", key: "zusatz_steuerbar", width: 18 },
      { header: "AHV/IV/EO", key: "abzug_ahv_iv_eo", width: 11 }, { header: "ALV", key: "abzug_alv", width: 9 }, { header: "NBU", key: "abzug_nbu", width: 9 },
      { header: "BVG", key: "abzug_bvg", width: 9 }, { header: "KTG", key: "abzug_ktg", width: 9 },
      { header: "Spesen", key: "spesen", width: 10 }, { header: "Auszahlung", key: "auszahlungsbetrag", width: 12 },
    ];
    s.getRow(1).font = { bold: true };
    for (const v of summen.values()) s.addRow(v);
    const info = wb.addWorksheet("Info");
    info.addRow([`Jahr ${jahr}, Basis ${basis === "auszahlung" ? "Auszahlungsjahr (AHV, Lohnausweis)" : "Arbeitsjahr"}`]);
    info.addRow(["Je Lohnmonat zählt nur die letzte Fassung; Korrektur-Differenzen zählen im Jahr ihrer Auszahlung."]);
    info.addRow(["Abzüge je Art netto (Rückerstattungen eingerechnet). Spesen sind nicht im Brutto; Auszahlung = Netto + Spesen."]);
    info.addRow(["Lohnabrechnungen ohne Momentaufnahme (von Hand hochgeladen, Altbestand nicht übernommen) fehlen in dieser Liste."]);
    const buffer = await wb.xlsx.writeBuffer();
    return new NextResponse(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="eventline-jahresliste_${jahr}_${basis}.xlsx"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
