// GET /api/hr/timesheet?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Excel-Export (.xlsx) für ganze Lohnmonate: alle Monate, die der Zeitraum
// berührt. Jede Zahl kommt aus dem Rechenkern (src/lib/lohn/kern über
// daten.ts) — dieselbe Rechnung wie Lohnabrechnung, Monatstabelle,
// Lohn-Details und «Mein Monat». Excel = Summe der Monatsergebnisse:
//   - «Übersicht»: je Person die Summen aller Monate
//   - je Person ein Blatt: Tage (gestempelt, Nacht, Sonntag, Lohnzeile, info
//     geplant/rapportiert) und je Monat die Lohnarten, Abzüge, Netto, NBU
//   - «Info»: Zeitraum, Regeln
// Kern-Fehler (fehlende Daten) stehen als Fehler im Blatt, nie als 0.
//
// Zugriff: lohn:manage + vertrautes Gerät.

import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { todayLocalIso } from "@/lib/swiss-time";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { KERN_VERSION, monatsLetzter, summeChf, type MonatsErgebnis } from "@/lib/lohn/kern";
import { ladeAlleSeiten, monatKey, rechneMonate, type MonatsAuftrag } from "@/lib/lohn/daten";
import { ladeInfoMinuten, summeImMonat } from "@/lib/lohn/info-minuten";

const WOCHENTAGE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const h2 = (min: number) => Number((min / 60).toFixed(2));

function monateZwischen(von: string, bis: string): MonatsAuftrag[] {
  const out: MonatsAuftrag[] = [];
  let j = Number(von.slice(0, 4));
  let m = Number(von.slice(5, 7));
  const ende = Number(bis.slice(0, 4)) * 12 + Number(bis.slice(5, 7));
  while (j * 12 + m <= ende) {
    out.push({ jahr: j, monat: m });
    m++;
    if (m === 13) { m = 1; j++; }
  }
  return out;
}

export async function GET(req: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ success: false, error: "from + to (YYYY-MM-DD) erforderlich" }, { status: 400 });
  }
  if (from > to) return NextResponse.json({ success: false, error: "from muss <= to sein" }, { status: 400 });
  const monate = monateZwischen(from, to);
  if (monate.length > 24) return NextResponse.json({ success: false, error: "Höchstens 24 Monate je Export" }, { status: 400 });
  await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_EXPORT, geraetHash: await geraetHashAusCookies(), details: { von: from, bis: to } });

  const admin = createAdminClient();
  const vonTag = `${monate[0].jahr}-${String(monate[0].monat).padStart(2, "0")}-01`;
  const letzter = monate[monate.length - 1];
  const bisTag = monatsLetzter(letzter.jahr, letzter.monat);

  let profile: { id: string; full_name: string | null; role: string; is_active: boolean | null }[];
  let ergebnisse: Awaited<ReturnType<typeof rechneMonate>>;
  let info: Awaited<ReturnType<typeof ladeInfoMinuten>>;
  try {
    profile = await ladeAlleSeiten(
      (a, b) => admin.from("profiles").select("id, full_name, role, is_active").not("role", "in", PORTAL_ROLLEN_IN).order("full_name").order("id").range(a, b),
      "Profile",
    );
    const ids = profile.map((p) => p.id);
    [ergebnisse, info] = await Promise.all([
      rechneMonate(admin, ids, monate),
      ladeInfoMinuten(admin, ids, vonTag, bisTag),
    ]);
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "EVENTLINE FSM";
  wb.created = new Date(`${bisTag}T12:00:00Z`);
  let logoId: number | null = null;
  try {
    const buf = await fs.promises.readFile(path.join(process.cwd(), "public", "logo-gmbh-black.png"));
    logoId = wb.addImage({ buffer: new Uint8Array(buf).buffer, extension: "png" });
  } catch { /* ohne Logo */ }
  const logo = (sheet: ExcelJS.Worksheet, spalte: number) => {
    if (logoId == null) return;
    sheet.addImage(logoId, { tl: { col: spalte - 2, row: 0 }, ext: { width: 130, height: 30 } });
    sheet.getRow(1).height = 24;
  };
  const kopf = (sheet: ExcelJS.Worksheet) => {
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } };
  };

  const uebersicht = wb.addWorksheet("Übersicht");
  uebersicht.columns = [
    { header: "Mitarbeiter", key: "name", width: 26 },
    { header: "Rolle", key: "role", width: 12 },
    { header: "Stempel h", key: "stunden", width: 10 },
    { header: "Geplant h", key: "geplant", width: 10 },
    { header: "Rapport h", key: "rapport", width: 10 },
    { header: "Nacht h (Zuschlag)", key: "nacht", width: 12 },
    { header: "So/FT h (Zuschlag)", key: "sonntag", width: 12 },
    { header: "Brutto CHF", key: "brutto", width: 12 },
    { header: "Abzüge CHF", key: "abzuege", width: 12 },
    { header: "Netto CHF", key: "netto", width: 12 },
    { header: "Vollkosten CHF", key: "vollkosten", width: 13 },
    { header: "Fehler", key: "fehler", width: 40 },
  ];
  kopf(uebersicht);
  logo(uebersicht, 12);

  for (const p of profile) {
    const jeMonat = ergebnisse.ergebnisse.get(p.id);
    const lp = ergebnisse.personen.get(p.id);
    const prefixe = monate.map((m) => `${monatKey(m.jahr, m.monat)}-`);
    const geplantMin = prefixe.reduce((s, pr) => s + summeImMonat(info.geplant.get(p.id), pr), 0);
    const rapportMin = prefixe.reduce((s, pr) => s + summeImMonat(info.rapport.get(p.id), pr), 0);
    const hatLohn = (lp?.lohnzeilen.length ?? 0) > 0;
    const ok = monate.map((m) => jeMonat?.get(monatKey(m.jahr, m.monat))).filter((r) => r?.ok).map((r) => (r as { ergebnis: MonatsErgebnis }).ergebnis);
    const fehler = monate.map((m) => jeMonat?.get(monatKey(m.jahr, m.monat))).filter((r) => r && !r.ok).map((r) => (r as { fehler: string }).fehler);
    const minuten = ok.reduce((s, e) => s + e.mengen.minuten, 0);
    if (!hatLohn && geplantMin === 0 && rapportMin === 0) continue;
    if (ok.every((e) => e.mengen.minuten === 0) && fehler.length === 0 && geplantMin === 0 && rapportMin === 0 && p.is_active !== true) continue;

    const blattName = (p.full_name ?? "").replace(/[\\/?*:[\]]/g, "_").slice(0, 31) || `Person-${p.id.slice(0, 8)}`;
    const blatt = wb.addWorksheet(blattName);
    blatt.columns = [
      { header: "Datum", key: "datum", width: 12 },
      { header: "Tag", key: "wt", width: 6 },
      { header: "Sonn-/Feiertag", key: "ft", width: 16 },
      { header: "Stempel-Min", key: "min", width: 12 },
      { header: "Nacht-Min", key: "nacht", width: 11 },
      { header: "Sonntag-Min", key: "sonntag", width: 12 },
      { header: "Basislohn CHF/h", key: "basis", width: 15 },
      { header: "Ferien %", key: "ferien", width: 9 },
      { header: "Geplant-Min", key: "geplant", width: 12 },
      { header: "Rapport-Min", key: "rapport", width: 12 },
      { header: "Notiz", key: "notiz", width: 30 },
    ];
    kopf(blatt);
    logo(blatt, 11);

    for (const m of monate) {
      const k = monatKey(m.jahr, m.monat);
      const r = jeMonat?.get(k);
      const titel = blatt.addRow({ datum: `${MONATE[m.monat - 1]} ${m.jahr}` });
      titel.font = { bold: true };
      if (!r) {
        blatt.addRow({ datum: "keine Lohnzeile" });
        continue;
      }
      if (!r.ok) {
        const z = blatt.addRow({ datum: "FEHLER", notiz: r.fehler });
        z.font = { bold: true, color: { argb: "FFCC0000" } };
        continue;
      }
      const e = r.ergebnis;
      const tage = new Map(e.tage.map((t) => [t.datum, t]));
      const alleTage = new Set<string>([...tage.keys(),
        ...[...(info.geplant.get(p.id) ?? new Map()).keys()].filter((d: string) => d.startsWith(`${k}-`)),
        ...[...(info.rapport.get(p.id) ?? new Map()).keys()].filter((d: string) => d.startsWith(`${k}-`))]);
      for (const d of [...alleTage].sort()) {
        const t = tage.get(d);
        const wt = new Date(`${d}T12:00:00Z`).getUTCDay();
        blatt.addRow({
          datum: d,
          wt: WOCHENTAGE[wt],
          ft: t?.feiertagName ?? "",
          min: t?.minuten ?? 0,
          nacht: t?.nachtMinuten ?? 0,
          sonntag: t?.sonntagMinuten ?? 0,
          basis: t?.basislohn != null ? Number(t.basislohn.toFixed(4)) : "",
          ferien: t?.ferienPct ?? "",
          geplant: info.geplant.get(p.id)?.get(d) ?? 0,
          rapport: info.rapport.get(p.id)?.get(d) ?? 0,
          notiz: t && t.ausserhalbAnstellung > 0 ? `${t.ausserhalbAnstellung} Min ausserhalb Anstellung` : "",
        });
      }
      blatt.addRow({ datum: "Lohnart", min: "Menge h", basis: "Ansatz", notiz: "CHF" }).font = { italic: true };
      for (const pos of e.positionen) {
        blatt.addRow({ datum: pos.bezeichnung, min: pos.minuten != null ? h2(pos.minuten) : "", basis: pos.ansatz != null ? Number(pos.ansatz.toFixed(4)) : pos.prozent != null ? `${pos.prozent} %` : "", notiz: pos.betrag });
      }
      blatt.addRow({ datum: "Bruttolohn", notiz: e.brutto }).font = { bold: true };
      for (const a of e.abzuege) {
        if (a.rueckerstattung) blatt.addRow({ datum: a.bezeichnung, notiz: -a.betrag });
        else if (a.prozent > 0) blatt.addRow({ datum: `${a.bezeichnung} ${a.prozent} %`, notiz: -a.betrag });
      }
      blatt.addRow({ datum: "Nettolohn", notiz: e.netto }).font = { bold: true };
      // Phase 4: Spesen-Zusatzposten nach dem Netto
      for (const z of e.zusatzposten) if (z.art === "spesen") blatt.addRow({ datum: `Spesen: ${z.bezeichnung}`, notiz: z.betrag });
      if (e.spesen !== 0) blatt.addRow({ datum: "Auszahlung", notiz: e.auszahlungsbetrag }).font = { bold: true };
      blatt.addRow({ datum: "NBU", notiz: e.nbu.begruendung });
      blatt.addRow({ datum: "Auszahlung (Regel)", notiz: e.auszahlungsdatum });
      for (const h of e.hinweise) blatt.addRow({ datum: "Hinweis", notiz: h.text }).font = { italic: true, color: { argb: "FF666666" } };
      blatt.addRow({});
    }

    uebersicht.addRow({
      name: (p.full_name ?? "?") + (p.is_active ? "" : " (inaktiv)"),
      role: p.role,
      stunden: h2(minuten),
      geplant: h2(geplantMin),
      rapport: h2(rapportMin),
      nacht: h2(ok.reduce((s, e) => s + e.mengen.nachtMinutenMitZuschlag, 0)),
      sonntag: h2(ok.reduce((s, e) => s + e.mengen.sonntagMinutenMitZuschlag, 0)),
      brutto: summeChf(ok.map((e) => e.brutto)),
      abzuege: summeChf(ok.map((e) => e.totalAbzuege)),
      netto: summeChf(ok.map((e) => e.netto)),
      vollkosten: summeChf(ok.map((e) => e.vollkosten)),
      fehler: fehler.join(" · "),
    });
  }

  const infoBlatt = wb.addWorksheet("Info");
  infoBlatt.columns = [{ key: "k", width: 20 }, { key: "v", width: 90 }];
  infoBlatt.addRow({ k: "Lohnmonate", v: `${MONATE[monate[0].monat - 1]} ${monate[0].jahr} bis ${MONATE[letzter.monat - 1]} ${letzter.jahr} (ganze Monate)` });
  infoBlatt.addRow({ k: "Erstellt", v: todayLocalIso() });
  infoBlatt.addRow({ k: "Erstellt von", v: auth.user.email ?? auth.user.id });
  infoBlatt.addRow({ k: "Rechnung", v: `Rechenkern ${KERN_VERSION} — identisch mit Lohnabrechnung und Monatstabelle. Summen = Summe der Monatsergebnisse.` });
  infoBlatt.addRow({ k: "Regeln", v: "Lohn tageweise; Sonntag Sa 23–So 23 (bis 6/Jahr 50 %); Nacht 23–6 (bis 24 Nächte/Jahr 25 %, danach Zeitzuschlag 10 %); 1. August 0,39 %; Ferienzuschlag 8,33 % / 10,64 %; NBU nach 7/87; Sätze nach Auszahlungsdatum; Beträge je Position auf 5 Rappen." });
  infoBlatt.addRow({ k: "Geplant/Rapport", v: "nur zur Information — ausbezahlt wird die gestempelte Zeit." });

  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="eventline-timesheet_${from}_${to}.xlsx"`,
    },
  });
}
