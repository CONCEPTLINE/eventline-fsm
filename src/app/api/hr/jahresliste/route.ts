// GET /api/hr/jahresliste?jahr=YYYY&basis=auszahlung|arbeit[&format=xlsx]
//
// Jahresliste je Person und Lohnmonat (Phase 2): AHV-Lohn, davon beitragsfrei
// (2'500-Grenze, Art. 34d AHVV), ALV-Lohn bis Höchstgrenze, UVG-Lohn nur BU
// bzw. BU+NBU, Quellensteuer, Lohnperiode — mit Arbeits- und Auszahlungsjahr.
// Grundlage: die Momentaufnahmen (je Monat zählt nur die letzte Fassung,
// Korrektur-Differenzen im Jahr ihrer Auszahlung). Seitenweise geladen.
// Grundlage für Lohnbescheinigung AK 40 und Lohnausweis.
//
// Zugriff: Lohnrecht + vertrautes Gerät.

import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ladeAlleSeiten } from "@/lib/lohn/daten";
import { jahresliste, type FassungFuerListe } from "@/lib/lohn/jahresliste";
import { summeChf } from "@/lib/lohn/kern";

interface Zeile {
  id: string;
  profile_id: string;
  jahr: number;
  monat: number;
  fassung: number;
  art: FassungFuerListe["art"];
  wage_document_id: string | null;
  auszahlungsdatum: string;
  brutto: string | number;
  netto: string | number;
  ahv_lohn: string | number;
  alv_lohn: string | number;
  uvg_lohn: string | number;
  uvg_art: "bu" | "bu_nbu";
  quellensteuer: string | number;
  lohnperiode: { von: string; bis: string } | null;
}

const SUMMEN_SCHLUESSEL = ["ahv_lohn", "ahv_beitragsfrei", "alv_lohn", "uvg_lohn_nur_bu", "uvg_lohn_bu_nbu", "quellensteuer", "brutto", "netto"] as const;

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
    const roh = await ladeAlleSeiten<Zeile>(
      (a, b) => admin.from("lohn_momentaufnahmen")
        .select("id, profile_id, jahr, monat, fassung, art, wage_document_id, auszahlungsdatum, brutto, netto, ahv_lohn, alv_lohn, uvg_lohn, uvg_art, quellensteuer, lohnperiode:ergebnis->lohnperiode")
        .gte("jahr", jahr - 1).lte("jahr", jahr + 1).order("id").range(a, b) as unknown as PromiseLike<{ data: Zeile[] | null; error: { message: string } | null }>,
      "Momentaufnahmen",
    );
    const docIds = Array.from(new Set(roh.map((r) => r.wage_document_id).filter((x): x is string => !!x)));
    const imKorb = new Set<string>();
    for (let i = 0; i < docIds.length; i += 150) {
      const teil = docIds.slice(i, i + 150);
      const d = await ladeAlleSeiten<{ id: string }>(
        (a, b) => admin.from("wage_documents").select("id").in("id", teil).not("archived_at", "is", null).order("id").range(a, b),
        "Lohndokumente",
      );
      for (const x of d) imKorb.add(x.id);
    }
    const ids = Array.from(new Set(roh.map((r) => r.profile_id)));
    const name = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 150) {
      const teil = ids.slice(i, i + 150);
      const p = await ladeAlleSeiten<{ id: string; full_name: string | null }>((a, b) => admin.from("profiles").select("id, full_name").in("id", teil).order("id").range(a, b), "Profile");
      for (const x of p) name.set(x.id, x.full_name ?? "?");
    }
    const anst = await ladeAlleSeiten<{ id: string; profile_id: string; ahv_verlangt_jahre: number[] | null }>(
      (a, b) => admin.from("lohn_anstellungen").select("id, profile_id, ahv_verlangt_jahre").order("id").range(a, b),
      "Anstellungen",
    );
    const verlangt = new Set(anst.flatMap((a) => (a.ahv_verlangt_jahre ?? []).map((j) => `${a.profile_id}|${j}`)));

    const zeilen = jahresliste(
      roh.map((r) => ({
        profile_id: r.profile_id, jahr: r.jahr, monat: r.monat, fassung: r.fassung, art: r.art, auszahlungsdatum: r.auszahlungsdatum,
        im_papierkorb: !!r.wage_document_id && imKorb.has(r.wage_document_id),
        brutto: Number(r.brutto), netto: Number(r.netto), ahv_lohn: Number(r.ahv_lohn), alv_lohn: Number(r.alv_lohn), uvg_lohn: Number(r.uvg_lohn),
        uvg_art: r.uvg_art, quellensteuer: Number(r.quellensteuer), lohnperiode: r.lohnperiode,
      })),
      { jahr, basis, ahvVerlangt: (p, j) => verlangt.has(`${p}|${j}`) },
    )
      .map((z) => ({ ...z, name: name.get(z.profile_id) ?? "?" }))
      .sort((a, b) => a.name.localeCompare(b.name, "de-CH") || a.arbeitsjahr - b.arbeitsjahr || a.monat - b.monat);

    // Summen je Person (Lohnbescheinigung)
    type Summe = Record<(typeof SUMMEN_SCHLUESSEL)[number], number> & { name: string; von: string | null; bis: string | null };
    const summen = new Map<string, Summe>();
    for (const z of zeilen) {
      const s: Summe = summen.get(z.profile_id) ?? { name: z.name, von: null, bis: null, ahv_lohn: 0, ahv_beitragsfrei: 0, alv_lohn: 0, uvg_lohn_nur_bu: 0, uvg_lohn_bu_nbu: 0, quellensteuer: 0, brutto: 0, netto: 0 };
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
    ];
    blatt.getRow(1).font = { bold: true };
    for (const z of zeilen) blatt.addRow({ ...z, daten: z.auszahlungsdaten.join(", ") });
    const s = wb.addWorksheet("Summen je Person");
    s.columns = [
      { header: "Person", key: "name", width: 24 }, { header: "Lohnperiode von", key: "von", width: 14 }, { header: "bis", key: "bis", width: 12 },
      { header: "AHV-Lohn", key: "ahv_lohn", width: 11 }, { header: "davon beitragsfrei", key: "ahv_beitragsfrei", width: 17 }, { header: "ALV-Lohn", key: "alv_lohn", width: 11 },
      { header: "UVG nur BU", key: "uvg_lohn_nur_bu", width: 12 }, { header: "UVG BU+NBU", key: "uvg_lohn_bu_nbu", width: 12 }, { header: "Quellensteuer", key: "quellensteuer", width: 13 },
      { header: "Brutto", key: "brutto", width: 11 }, { header: "Netto", key: "netto", width: 11 },
    ];
    s.getRow(1).font = { bold: true };
    for (const v of summen.values()) s.addRow(v);
    const info = wb.addWorksheet("Info");
    info.addRow([`Jahr ${jahr}, Basis ${basis === "auszahlung" ? "Auszahlungsjahr (AHV, Lohnausweis)" : "Arbeitsjahr"}`]);
    info.addRow(["Je Lohnmonat zählt nur die letzte Fassung; Korrektur-Differenzen zählen im Jahr ihrer Auszahlung."]);
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
