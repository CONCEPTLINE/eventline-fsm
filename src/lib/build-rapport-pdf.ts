/**
 * Rapport-PDF-Builder — generiert ein Einsatzrapport-PDF aus einem
 * service_reports-Row + zugehoerigem job (mit customer/location).
 *
 * Wird genutzt von:
 *   - GET  /api/reports/[id]/pdf      (Einzeldownload)
 *   - GET  /api/reports/export-zip    (Bulk-Download im Zeitraum)
 *
 * Returnt einen Buffer (Node) — Caller kuemmert sich um Headers /
 * ZIP-Verpackung.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import LOGO_BASE64 from "@/lib/logo-base64";

interface TimeRange {
  date: string;
  start: string;
  end: string;
  pause: number;
  not_billable?: boolean;
  not_billable_reason?: string;
}

export interface RapportReportRow {
  id: string;
  report_date: string;
  work_description: string | null;
  equipment_used: string | null;
  issues: string | null;
  technician_name: string | null;
  client_name: string | null;
  technician_signature_url: string | null;
  signature_url: string | null;
  time_ranges: TimeRange[] | null;
}

export interface RapportJobInfo {
  title: string | null;
  job_number: number | null;
  /** Freitext aus jobs.verwaltungsaufwand — wird im Rapport-PDF unter den
   *  Einsatzzeiten als eigene Sektion ausgewiesen. Null wenn leer. */
  verwaltungsaufwand?: string | null;
  /** Quantifizierter Aufwand in Minuten. Wird im PDF als 'X Min' bzw
   *  'Xh Ym' formatiert ueber dem Freitext gezeigt. */
  verwaltungsaufwand_minutes?: number | null;
  customer: {
    name: string | null;
    address_street?: string | null;
    address_zip?: string | null;
    address_city?: string | null;
  } | null;
  location: { name: string | null } | null;
}

/** Erzeugt das Rapport-PDF und gibt einen Node-Buffer zurueck. */
export async function buildRapportPdf(
  report: RapportReportRow,
  job: RapportJobInfo | null,
  adminClient: SupabaseClient,
): Promise<Buffer> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 20;
  const customer = job?.customer ?? null;
  const location = job?.location ?? null;
  const timeRanges: TimeRange[] = report.time_ranges ?? [];

  try {
    const logoWidth = 70;
    const logoHeight = logoWidth / 4.32;
    doc.addImage(LOGO_BASE64, "PNG", pageWidth - 14 - logoWidth, 12, logoWidth, logoHeight);
  } catch { /* logo missing — non-fatal */ }

  // Titel + Auftragsnummer
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("Einsatzrapport", 14, y);
  if (job?.job_number) {
    doc.setFontSize(10);
    doc.setTextColor(150);
    doc.text(`INT-${job.job_number}`, 14, y + 7);
    doc.setTextColor(0);
    y += 4;
  }

  y += 10;
  doc.setDrawColor(220);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageWidth - 14, y);

  // Auftragsdaten
  y += 8;
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("Auftrag:", 14, y);
  doc.setFont("helvetica", "normal");
  doc.text(job?.title || "-", 55, y);

  y += 6;
  doc.setFont("helvetica", "bold");
  doc.text("Kunde:", 14, y);
  doc.setFont("helvetica", "normal");
  doc.text(customer?.name || "-", 55, y);
  if (customer?.address_street) {
    y += 5;
    doc.text(`${customer.address_street}, ${customer.address_zip || ""} ${customer.address_city || ""}`, 55, y);
  }

  y += 6;
  doc.setFont("helvetica", "bold");
  doc.text("Standort:", 14, y);
  doc.setFont("helvetica", "normal");
  doc.text(location?.name || "-", 55, y);

  // Einsatzzeiten
  if (timeRanges.length > 0) {
    y += 10;
    doc.setDrawColor(220);
    doc.line(14, y, pageWidth - 14, y);

    y += 8;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Einsatzzeiten", 14, y);

    y += 7;
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(120);
    doc.text("Datum", 14, y);
    doc.text("Von", 60, y);
    doc.text("Bis", 80, y);
    doc.text("Pause", 100, y);
    doc.text("Arbeitszeit", 125, y);
    doc.text("Verrechnung", 160, y);
    doc.setTextColor(0);

    y += 2;
    doc.setDrawColor(230);
    doc.line(14, y, pageWidth - 14, y);

    let billableMin = 0;
    let notBillableMin = 0;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    for (const tr of timeRanges) {
      y += 5;
      const dateStr = new Date(tr.date + "T12:00:00Z").toLocaleDateString("de-CH", {
        timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
      });
      const [sh, sm] = tr.start.split(":").map(Number);
      const [eh, em] = tr.end.split(":").map(Number);
      const workMin = Math.max(0, (eh * 60 + em) - (sh * 60 + sm) - tr.pause);
      if (tr.not_billable) notBillableMin += workMin;
      else billableMin += workMin;
      const workH = Math.floor(workMin / 60);
      const workM = workMin % 60;
      if (tr.not_billable) doc.setTextColor(150, 110, 0); // dunkles Gelb
      doc.text(dateStr, 14, y);
      doc.text(`${tr.start} Uhr`, 60, y);
      doc.text(`${tr.end} Uhr`, 80, y);
      doc.text(`${tr.pause} Min`, 100, y);
      doc.text(`${workH}h ${workM > 0 ? workM + "m" : ""}`.trim(), 125, y);
      doc.text(tr.not_billable ? "NICHT verr." : "Verrechnen", 160, y);
      doc.setTextColor(0);
      if (tr.not_billable && tr.not_billable_reason) {
        y += 4;
        doc.setFontSize(7.5);
        doc.setFont("helvetica", "italic");
        doc.setTextColor(150, 110, 0);
        const reasonLines = doc.splitTextToSize(`Grund: ${tr.not_billable_reason}`, pageWidth - 28 - 14);
        doc.text(reasonLines, 18, y);
        y += (reasonLines.length - 1) * 3.5;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(0);
      }
    }
    y += 3;
    doc.setDrawColor(200);
    doc.line(14, y, pageWidth - 14, y);
    y += 5;
    doc.setFont("helvetica", "bold");
    if (notBillableMin > 0) {
      // Split-Total: Verrechenbar + nicht verrechnet getrennt ausweisen.
      doc.text("Verrechenbar", 14, y);
      const bH = Math.floor(billableMin / 60);
      const bM = billableMin % 60;
      doc.text(`${bH}h ${bM > 0 ? bM + "m" : ""}`.trim(), 125, y);
      y += 5;
      doc.setTextColor(150, 110, 0);
      doc.text("Nicht verrechnet", 14, y);
      const nH = Math.floor(notBillableMin / 60);
      const nM = notBillableMin % 60;
      doc.text(`${nH}h ${nM > 0 ? nM + "m" : ""}`.trim(), 125, y);
      doc.setTextColor(0);
      y += 5;
      doc.setDrawColor(230);
      doc.line(14, y - 2, pageWidth - 14, y - 2);
      doc.text("Gesamt", 14, y);
      const totalH = Math.floor((billableMin + notBillableMin) / 60);
      const totalM = (billableMin + notBillableMin) % 60;
      doc.text(`${totalH}h ${totalM > 0 ? totalM + "m" : ""}`.trim(), 125, y);
    } else {
      doc.text("Total", 14, y);
      const totalH = Math.floor(billableMin / 60);
      const totalM = billableMin % 60;
      doc.text(`${totalH}h ${totalM > 0 ? totalM + "m" : ""}`.trim(), 125, y);
    }
    doc.setFont("helvetica", "normal");
  } else {
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.text("Datum:", 14, y);
    doc.setFont("helvetica", "normal");
    doc.text(new Date(report.report_date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" }), 55, y);
  }

  y += 8;
  doc.setDrawColor(220);
  doc.line(14, y, pageWidth - 14, y);

  // Verwaltungsaufwand (optional) — kommt direkt nach Einsatzzeiten,
  // damit der Kunde den administrativen Aufwand neben den geleisteten
  // Stunden einsortieren kann.
  const vText = job?.verwaltungsaufwand?.trim() ?? "";
  const vMin = job?.verwaltungsaufwand_minutes ?? 0;
  if (vText || vMin > 0) {
    y += 8;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Verwaltungsaufwand", 14, y);
    // Aufwand-Zeit rechtsbuendig in der gleichen Header-Zeile.
    if (vMin > 0) {
      const h = Math.floor(vMin / 60);
      const m = vMin % 60;
      const label = vMin >= 60 ? `${h}h ${m > 0 ? `${m}m` : ""}`.trim() : `${vMin} Min`;
      doc.setFontSize(10);
      doc.text(label, pageWidth - 14, y, { align: "right" });
    }
    y += 6;
    if (vText) {
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      const vLines = doc.splitTextToSize(vText, pageWidth - 28);
      doc.text(vLines, 14, y);
      y += vLines.length * 5 + 4;
    } else {
      y += 2;
    }
    doc.setDrawColor(220);
    doc.line(14, y, pageWidth - 14, y);
  }

  // Arbeitsbeschreibung
  y += 8;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Ausgeführte Arbeiten", 14, y);
  y += 6;
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  const workLines = doc.splitTextToSize(report.work_description || "-", pageWidth - 28);
  doc.text(workLines, 14, y);
  y += workLines.length * 5 + 4;

  // Material
  if (report.equipment_used) {
    y += 4;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Eingesetztes Material", 14, y);
    y += 6;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const equipLines = doc.splitTextToSize(report.equipment_used, pageWidth - 28);
    doc.text(equipLines, 14, y);
    y += equipLines.length * 5 + 4;
  }

  // Probleme / Bemerkungen
  if (report.issues) {
    y += 4;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Probleme / Bemerkungen", 14, y);
    y += 6;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const issueLines = doc.splitTextToSize(report.issues, pageWidth - 28);
    doc.text(issueLines, 14, y);
    y += issueLines.length * 5 + 4;
  }

  // Unterschriften
  y = Math.max(y + 10, 220);
  doc.setDrawColor(220);
  doc.line(14, y, pageWidth - 14, y);
  y += 8;
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("Service-Techniker:", 14, y);
  doc.setFont("helvetica", "normal");
  doc.text(report.technician_name || "-", 14, y + 5);
  doc.setDrawColor(180);
  doc.line(14, y + 20, 90, y + 20);
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text("Unterschrift Techniker", 14, y + 24);

  doc.setFontSize(10);
  doc.setTextColor(0);
  doc.setFont("helvetica", "bold");
  doc.text("Kunde / Auftraggeber:", 110, y);
  doc.setFont("helvetica", "normal");
  doc.text(report.client_name || "-", 110, y + 5);
  doc.line(110, y + 20, pageWidth - 14, y + 20);
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text("Unterschrift Kunde", 110, y + 24);

  // Footer
  doc.setTextColor(150);
  doc.setFontSize(7);
  doc.text(
    "EVENTLINE GmbH · St. Jakobs-Strasse 200 · CH-4052 Basel · Tel: 055 556 62 61 · www.eventline-basel.com",
    pageWidth / 2,
    285,
    { align: "center" },
  );

  // Signature images (best effort — fehlende Storage-Files brechen nicht)
  if (report.technician_signature_url) {
    try {
      const { data } = await adminClient.storage.from("documents").download(report.technician_signature_url);
      if (data) {
        const buf = Buffer.from(await data.arrayBuffer());
        doc.addImage(`data:image/png;base64,${buf.toString("base64")}`, "PNG", 14, y + 8, 60, 10);
      }
    } catch { /* missing signature is OK */ }
  }
  if (report.signature_url) {
    try {
      const { data } = await adminClient.storage.from("documents").download(report.signature_url);
      if (data) {
        const buf = Buffer.from(await data.arrayBuffer());
        doc.addImage(`data:image/png;base64,${buf.toString("base64")}`, "PNG", 110, y + 8, 60, 10);
      }
    } catch { /* missing signature is OK */ }
  }

  return Buffer.from(doc.output("arraybuffer"));
}

/** Vorgeschlagener Filename fuer einen Rapport. */
export function rapportFilename(report: RapportReportRow, job: RapportJobInfo | null): string {
  const num = job?.job_number ? `INT-${job.job_number}` : report.id.slice(0, 8);
  // report_date ist eine DATE-Spalte in Postgres und kommt als 'YYYY-MM-DD'
  // (ohne T) zurueck — slice(0,10) ist hier sicher kein UTC-Bug.
  const date = report.report_date ? report.report_date.slice(0, 10) : ""; // tz-ok
  const title = (job?.title ?? "")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 40);
  const parts = [date, num, title].filter(Boolean);
  return `Rapport_${parts.join("_")}.pdf`;
}
