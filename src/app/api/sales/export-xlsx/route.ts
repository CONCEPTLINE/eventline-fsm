// GET /api/sales/export-xlsx
//
// Exportiert alle Vertriebs-Leads als Excel-Workbook fuer KI-basierte
// Dedup ("schlag mir keine Firmen vor die wir schon haben").
//
// Bewusst minimaler Datensatz:
//   - Identifizierende Felder (Firma, Branche, Stadt-Hinweis, Email,
//     Telefon, Ansprechperson) damit eine KI Duplikate fuzzy matchen
//     kann.
//   - Status (offen / kontaktiert / gewonnen / abgesagt / verworfen)
//     damit die KI weiss 'haben wir versucht, war nichts'.
//   - KEINE internen Notizen, KEINE Stempelzeiten, KEINE Lohn-Daten.
//
// Permission: vertrieb:view reicht — wer die Leads sieht, darf sie
// auch exportieren. Eine separate Export-Permission waere Overkill.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api-auth";
import ExcelJS from "exceljs";

const STATUS_LABEL: Record<string, string> = {
  offen: "Offen",
  kontaktiert: "Kontaktiert",
  gespraech: "In Gespraech",
  gewonnen: "Gewonnen",
  abgesagt: "Abgesagt",
  verworfen: "Verworfen",
};

export async function GET() {
  const auth = await requirePermission("vertrieb:view");
  if (auth.error) return auth.error;

  const userClient = await createClient();
  const { data: contacts, error } = await userClient
    .from("vertrieb_contacts")
    .select("nr, firma, branche, ansprechperson, position, email, telefon, kategorie, status, datum_kontakt, created_at")
    .order("firma", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const wb = new ExcelJS.Workbook();
  wb.creator = "EVENTLINE FSM";
  wb.created = new Date();

  // ── Sheet 1: alle Leads ──
  const sheet = wb.addWorksheet("Leads", {
    views: [{ state: "frozen", ySplit: 1 }], // Header-Zeile festhalten beim Scrollen
  });
  sheet.columns = [
    { header: "Nr",            key: "nr",            width: 8 },
    { header: "Firma",         key: "firma",         width: 32 },
    { header: "Branche",       key: "branche",       width: 22 },
    { header: "Kategorie",     key: "kategorie",     width: 18 },
    { header: "Status",        key: "status",        width: 14 },
    { header: "Ansprechperson", key: "ansprechperson", width: 24 },
    { header: "Position",      key: "position",      width: 20 },
    { header: "Email",         key: "email",         width: 32 },
    { header: "Telefon",       key: "telefon",       width: 18 },
    { header: "Letzter Kontakt", key: "datum_kontakt", width: 16 },
    { header: "Angelegt",      key: "created_at",    width: 16 },
  ];

  // Header-Styling
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF991010" } };
  header.alignment = { vertical: "middle", horizontal: "left" };
  header.height = 22;

  type Row = {
    nr: number;
    firma: string;
    branche: string | null;
    ansprechperson: string | null;
    position: string | null;
    email: string | null;
    telefon: string | null;
    kategorie: string | null;
    status: string;
    datum_kontakt: string | null;
    created_at: string;
  };

  for (const c of (contacts as Row[] | null) ?? []) {
    sheet.addRow({
      nr: c.nr,
      firma: c.firma,
      branche: c.branche ?? "",
      kategorie: c.kategorie ?? "",
      status: STATUS_LABEL[c.status] ?? c.status,
      ansprechperson: c.ansprechperson ?? "",
      position: c.position ?? "",
      email: c.email ?? "",
      telefon: c.telefon ?? "",
      datum_kontakt: c.datum_kontakt ?? "",
      created_at: c.created_at
        ? new Date(c.created_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })
        : "",
    });
  }

  // Auto-Filter ueber alle Spalten (Excel-User kann sortieren/filtern)
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount },
  };

  // ── Sheet 2: Info / Kontext fuer die KI ──
  const info = wb.addWorksheet("README");
  info.columns = [{ key: "k", width: 24 }, { key: "v", width: 80 }];
  const infoRows: [string, string][] = [
    ["Datei", "EVENTLINE Vertriebs-Leads — Export"],
    ["Generiert", new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" })],
    ["Anzahl Leads", String(contacts?.length ?? 0)],
    ["", ""],
    ["Zweck", "Diese Liste an eine KI uebergeben damit sie keine Leads vorschlaegt die wir bereits haben."],
    ["", ""],
    ["Status-Bedeutung", ""],
    ["  Offen", "noch nie kontaktiert"],
    ["  Kontaktiert", "Erstkontakt gelaufen, in Pipeline"],
    ["  In Gespraech", "aktive Verhandlung"],
    ["  Gewonnen", "Auftrag erhalten — bestehender Kunde"],
    ["  Abgesagt", "Lead hat abgelehnt — NICHT erneut vorschlagen"],
    ["  Verworfen", "Wir haben den Lead nicht weiterverfolgt — NICHT erneut vorschlagen"],
    ["", ""],
    ["Dedup-Strategie", "Match auf Firma (fuzzy) plus Email/Telefon als Tie-Breaker."],
  ];
  for (const [k, v] of infoRows) info.addRow({ k, v });
  info.getColumn("k").font = { bold: true };

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Leads_${new Date().toISOString().slice(0, 10)}.xlsx`; // tz-ok: ISO-Datum nur fuer Filename
  return new NextResponse(buffer as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
