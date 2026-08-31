// POST /api/analytics/locations/pdf
//
// Body: { from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }
//
// Baut die Location-Auslastungsuebersicht als A4-quer-PDF (analog UI-
// Tabelle in src/components/analytics/location-overview.tsx). Nutzt die
// gleiche SECURITY-DEFINER-RPC get_location_stats wie GET /api/analytics
// /locations — Berechtigung strikt admin-only via requireTrustedDevice
// ("lohn:manage") + interner is_admin()-Guard in der RPC.
//
// Design: Header mit Logo (rechts), Titel + Zeitraum + Generierungsdatum
// links; Tabelle mit den gleichen Spalten wie im UI (Location, Auftr.,
// Geplant, Stempel, Rapport, ΔKalk., ΔRap., Satz, Umsatz, Kosten, Marge,
// Zuletzt); Fusszeile mit Firmen-Total analog UI-tfoot; Firmen-Stamm-
// daten ganz unten via formatFullFooter.
//
// Content-Type: application/pdf, Attachment mit sprechendem Filename.
// Wichtig: KEIN await auf createAdminClient fuer die RPC — die Aggregation
// laeuft ueber den User-Client damit is_admin() in der RPC den auth-User
// sieht (analog GET-Route).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCompanySettings, formatFullFooter } from "@/lib/company-settings";
import LOGO_BASE64 from "@/lib/logo-base64";
import { jsPDF } from "jspdf";

interface Row {
  location_id: string;
  location_name: string;
  job_count: number;
  geplant_minutes: number;
  stempel_minutes: number;
  rapport_minutes: number;
  last_job_date: string | null;
  hourly_rate_chf: number | null;
  vollkosten_chf: number;
}

const CHF_FMT = new Intl.NumberFormat("de-CH", { style: "decimal", maximumFractionDigits: 0 });
const RATE_FMT = new Intl.NumberFormat("de-CH", { style: "decimal", maximumFractionDigits: 2 });

function isDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function formatHours(min: number): string {
  const h = min / 60;
  if (h >= 100) return `${Math.round(h)}h`;
  return `${h.toFixed(1)}h`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "2-digit",
  });
}

function pctDelta(a: number, b: number): number | null {
  if (a <= 0) return null;
  return ((b - a) / a) * 100;
}

function rangeLabel(from: string | undefined, to: string | undefined): string {
  if (!from && !to) return "Alle Zeit";
  const fmt = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric",
  });
  if (from && to) return `${fmt(from)} — ${fmt(to)}`;
  if (from) return `ab ${fmt(from)}`;
  return `bis ${fmt(to as string)}`;
}

export async function POST(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({})) as { from?: unknown; to?: unknown; scope?: unknown };
  const from = isDate(body.from) ? body.from : undefined;
  const to = isDate(body.to) ? body.to : undefined;
  const scope: "all" | "past" | "future" =
    (body.scope === "past" || body.scope === "future") ? body.scope : "all";

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_location_stats", {
    p_from: from ?? "2000-01-01",
    p_to: to ?? "9999-12-31",
    p_scope: scope,
  });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  const rows = (data ?? []) as Row[];

  const admin = createAdminClient();
  const company = await loadCompanySettings(admin);
  const footerLine = formatFullFooter(company);

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();   // ~297
  const pageHeight = doc.internal.pageSize.getHeight(); // ~210
  const marginX = 12;
  const marginTop = 14;
  const marginBottom = 14;

  // --- Header
  try {
    const logoWidth = 55;
    const logoHeight = logoWidth / 4.32;
    doc.addImage(LOGO_BASE64, "PNG", pageWidth - marginX - logoWidth, marginTop - 2, logoWidth, logoHeight);
  } catch { /* logo missing — non-fatal */ }

  let y = marginTop + 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(0);
  doc.text("Location-Auslastungsuebersicht", marginX, y);

  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  const scopeLabel = scope === "past" ? " · Nur Vergangenheit" : scope === "future" ? " · Nur Zukunft" : "";
  doc.text(`Zeitraum: ${rangeLabel(from, to)}${scopeLabel}`, marginX, y);
  const todayLabel = new Date().toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric",
  });
  doc.text(`Erstellt: ${todayLabel}`, marginX, y + 4);
  doc.setTextColor(0);

  y += 12;

  // Spalten-Definition (mm) — Summe muss < pageWidth - 2*marginX (~273) sein.
  // align='right' fuer numerische Spalten, sonst 'left'.
  interface Col {
    key: string;
    label: string;
    width: number;
    align: "left" | "right";
  }
  const cols: Col[] = [
    { key: "name",    label: "Location",   width: 55, align: "left"  },
    { key: "jobs",    label: "Auftr.",     width: 14, align: "right" },
    { key: "gep",     label: "Geplant",    width: 18, align: "right" },
    { key: "stp",     label: "Stempel",    width: 18, align: "right" },
    { key: "rap",     label: "Rapport",    width: 18, align: "right" },
    { key: "dkalk",   label: "Δ Kalk.",    width: 16, align: "right" },
    { key: "drap",    label: "Δ Rap.",     width: 16, align: "right" },
    { key: "rate",    label: "Satz CHF/h", width: 22, align: "right" },
    { key: "umsatz",  label: "Umsatz",     width: 22, align: "right" },
    { key: "kosten",  label: "Kosten",     width: 22, align: "right" },
    { key: "marge",   label: "Marge",      width: 30, align: "right" },
    { key: "letzt",   label: "Zuletzt",    width: 22, align: "right" },
  ];

  const xOfCol = (i: number): number => {
    let x = marginX;
    for (let k = 0; k < i; k++) x += cols[k].width;
    return x;
  };

  const drawCell = (x: number, y: number, w: number, text: string, align: "left" | "right") => {
    if (align === "right") doc.text(text, x + w - 1.5, y, { align: "right" });
    else doc.text(text, x + 1.5, y, { align: "left" });
  };

  const rowHeight = 6;
  const headerHeight = 8;

  const drawTableHeader = (yy: number): number => {
    doc.setFillColor(240, 240, 240);
    doc.rect(marginX, yy - 4.2, cols.reduce((s, c) => s + c.width, 0), headerHeight, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(60);
    cols.forEach((c, i) => drawCell(xOfCol(i), yy, c.width, c.label, c.align));
    doc.setTextColor(0);
    return yy + headerHeight;
  };

  const paginateIfNeeded = (yy: number, minSpace: number): number => {
    if (yy + minSpace > pageHeight - marginBottom - 8) {
      doc.addPage();
      return drawTableHeader(marginTop + 4);
    }
    return yy;
  };

  y = drawTableHeader(y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);

  // Firmen-Total mit-summieren (analog UI).
  let totJobs = 0, totGep = 0, totStp = 0, totRap = 0, totUms = 0, totKos = 0;

  for (const r of rows) {
    y = paginateIfNeeded(y, rowHeight);

    const stempelH = r.stempel_minutes / 60;
    const hasRate = r.hourly_rate_chf != null;
    const umsatz = hasRate ? stempelH * (r.hourly_rate_chf as number) : null;
    const kosten = Number(r.vollkosten_chf) || 0;
    const marge = umsatz != null ? umsatz - kosten : null;
    const margePct = umsatz != null && umsatz > 0 ? ((marge as number) / umsatz) * 100 : null;
    const dKalk = pctDelta(r.geplant_minutes, r.stempel_minutes);
    const dRap  = pctDelta(r.stempel_minutes, r.rapport_minutes);

    totJobs += r.job_count;
    totGep += r.geplant_minutes;
    totStp += r.stempel_minutes;
    totRap += r.rapport_minutes;
    if (hasRate) {
      totUms += umsatz ?? 0;
      totKos += kosten;
    }

    // Marge-Farbe (rot/gruen) und ΔRap-Farbe (rot wenn kritisch)
    const setColor = (rgb: [number, number, number]) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);
    const BLACK: [number, number, number] = [0, 0, 0];
    const MUTED: [number, number, number] = [130, 130, 130];
    const RED:   [number, number, number] = [200, 40, 40];
    const GREEN: [number, number, number] = [0, 130, 60];
    const AMBER: [number, number, number] = [180, 120, 0];

    const nameTrunc = r.location_name.length > 34 ? r.location_name.slice(0, 33) + "…" : r.location_name;
    setColor(BLACK);
    drawCell(xOfCol(0), y, cols[0].width, nameTrunc, "left");
    drawCell(xOfCol(1), y, cols[1].width, String(r.job_count), "right");
    setColor(MUTED);
    drawCell(xOfCol(2), y, cols[2].width, formatHours(r.geplant_minutes), "right");
    setColor(BLACK);
    drawCell(xOfCol(3), y, cols[3].width, formatHours(r.stempel_minutes), "right");
    setColor(MUTED);
    drawCell(xOfCol(4), y, cols[4].width, formatHours(r.rapport_minutes), "right");

    // Δ Kalk.
    if (dKalk === null) { setColor(MUTED); drawCell(xOfCol(5), y, cols[5].width, "—", "right"); }
    else {
      setColor(Math.abs(dKalk) > 20 ? AMBER : MUTED);
      drawCell(xOfCol(5), y, cols[5].width, `${dKalk >= 0 ? "+" : ""}${dKalk.toFixed(0)}%`, "right");
    }
    // Δ Rap.
    if (dRap === null) { setColor(MUTED); drawCell(xOfCol(6), y, cols[6].width, "—", "right"); }
    else {
      const critical = Math.abs(dRap) > 15;
      setColor(critical ? RED : MUTED);
      drawCell(xOfCol(6), y, cols[6].width, `${dRap >= 0 ? "+" : ""}${dRap.toFixed(0)}%`, "right");
    }

    // Satz
    setColor(BLACK);
    drawCell(xOfCol(7), y, cols[7].width, hasRate ? RATE_FMT.format(r.hourly_rate_chf as number) : "—", "right");
    // Umsatz
    drawCell(xOfCol(8), y, cols[8].width, umsatz != null ? CHF_FMT.format(umsatz) : "—", "right");
    // Kosten
    setColor(MUTED);
    drawCell(xOfCol(9), y, cols[9].width, kosten > 0 ? CHF_FMT.format(kosten) : "—", "right");
    // Marge (+ pct)
    if (marge === null) { setColor(MUTED); drawCell(xOfCol(10), y, cols[10].width, "—", "right"); }
    else {
      setColor(marge < 0 ? RED : GREEN);
      const mText = margePct != null
        ? `${CHF_FMT.format(marge)}  (${margePct.toFixed(0)}%)`
        : CHF_FMT.format(marge);
      drawCell(xOfCol(10), y, cols[10].width, mText, "right");
    }
    // Zuletzt
    setColor(MUTED);
    drawCell(xOfCol(11), y, cols[11].width, formatDate(r.last_job_date), "right");
    setColor(BLACK);

    y += rowHeight;
  }

  // Fuss-Total analog UI-tfoot
  y = paginateIfNeeded(y, rowHeight + 4);
  doc.setDrawColor(60);
  doc.setLineWidth(0.4);
  doc.line(marginX, y - 3, marginX + cols.reduce((s, c) => s + c.width, 0), y - 3);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);

  drawCell(xOfCol(0), y, cols[0].width, `Total (${rows.length} Locations)`, "left");
  drawCell(xOfCol(1), y, cols[1].width, String(totJobs), "right");
  doc.setTextColor(130);
  drawCell(xOfCol(2), y, cols[2].width, formatHours(totGep), "right");
  doc.setTextColor(0);
  drawCell(xOfCol(3), y, cols[3].width, formatHours(totStp), "right");
  doc.setTextColor(130);
  drawCell(xOfCol(4), y, cols[4].width, formatHours(totRap), "right");
  doc.setTextColor(0);
  // Satz-Spalte im Total leer.
  drawCell(xOfCol(8), y, cols[8].width, totUms > 0 ? CHF_FMT.format(totUms) : "—", "right");
  doc.setTextColor(130);
  drawCell(xOfCol(9), y, cols[9].width, totKos > 0 ? CHF_FMT.format(totKos) : "—", "right");
  const totMarge = totUms - totKos;
  const totMargePct = totUms > 0 ? (totMarge / totUms) * 100 : null;
  if (totUms === 0) {
    doc.setTextColor(130);
    drawCell(xOfCol(10), y, cols[10].width, "—", "right");
  } else {
    if (totMarge < 0) doc.setTextColor(200, 40, 40);
    else doc.setTextColor(0, 130, 60);
    const t = totMargePct != null
      ? `${CHF_FMT.format(totMarge)}  (${totMargePct.toFixed(0)}%)`
      : CHF_FMT.format(totMarge);
    drawCell(xOfCol(10), y, cols[10].width, t, "right");
  }
  doc.setTextColor(0);
  doc.setFont("helvetica", "normal");

  // Firmen-Stammdaten in der Fusszeile jeder Seite.
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setTextColor(150);
    doc.setFontSize(7);
    if (footerLine) doc.text(footerLine, pageWidth / 2, pageHeight - 6, { align: "center" });
    doc.text(`Seite ${p} / ${totalPages}`, pageWidth - marginX, pageHeight - 6, { align: "right" });
    doc.setTextColor(0);
  }

  const pdf = Buffer.from(doc.output("arraybuffer"));
  const dateTag = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Location-Uebersicht_${dateTag}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
