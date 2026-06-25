import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
// jsPDF wird lazy in generatePDF() geladen — ~180KB nicht im Cold-Start.
import LOGO_BASE64 from "@/lib/logo-base64";
import { requireUser } from "@/lib/api-auth";

interface TimeRange {
  date: string;
  start: string;
  end: string;
  pause: number;
  not_billable?: boolean;
  not_billable_reason?: string;
}

interface ReportPhoto {
  id: string;
  storage_path: string;
  caption: string | null;
  sort_order: number;
}

async function generatePDF(
  report: any,
  job: any,
  customer: any,
  location: any,
  photos: { base64: string; caption: string | null }[],
  signatures: { tech: string | null; client: string | null }
): Promise<Buffer> {
  const timeRanges: TimeRange[] = report.time_ranges || [];
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 20;

  // Logo rechts oben
  try {
    const logoWidth = 70;
    const logoHeight = logoWidth / 4.32;
    doc.addImage(LOGO_BASE64, "PNG", pageWidth - 14 - logoWidth, 12, logoWidth, logoHeight);
  } catch {}

  // Titel
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
      const dateStr = new Date(tr.date + "T12:00:00Z").toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
      const [sh, sm] = tr.start.split(":").map(Number);
      const [eh, em] = tr.end.split(":").map(Number);
      const workMin = Math.max(0, (eh * 60 + em) - (sh * 60 + sm) - tr.pause);
      if (tr.not_billable) notBillableMin += workMin;
      else billableMin += workMin;
      const workH = Math.floor(workMin / 60);
      const workM = workMin % 60;
      if (tr.not_billable) doc.setTextColor(150, 110, 0);
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

  // Trennlinie
  y += 8;
  doc.setDrawColor(220);
  doc.line(14, y, pageWidth - 14, y);

  // Verwaltungsaufwand (optional) — direkt nach Einsatzzeiten.
  if (job?.verwaltungsaufwand && String(job.verwaltungsaufwand).trim()) {
    y += 8;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Verwaltungsaufwand", 14, y);
    y += 6;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const vLines = doc.splitTextToSize(String(job.verwaltungsaufwand).trim(), pageWidth - 28);
    doc.text(vLines, 14, y);
    y += vLines.length * 5 + 4;
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

  // Fotos
  if (photos.length > 0) {
    // Neue Seite für Fotos wenn wenig Platz
    if (y > 180) {
      doc.addPage();
      y = 20;
    } else {
      y += 8;
      doc.setDrawColor(220);
      doc.line(14, y, pageWidth - 14, y);
      y += 8;
    }

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text(`Fotos (${photos.length})`, 14, y);
    y += 8;

    const imgWidth = 80;
    const imgHeight = 60;
    let col = 0;

    for (const photo of photos) {
      // Neue Seite wenn kein Platz mehr
      if (y + imgHeight + 10 > 280) {
        doc.addPage();
        y = 20;
        col = 0;
      }

      const x = col === 0 ? 14 : 108;

      try {
        doc.addImage(photo.base64, "JPEG", x, y, imgWidth, imgHeight);
      } catch {
        // Foto konnte nicht eingefügt werden
        doc.setDrawColor(200);
        doc.rect(x, y, imgWidth, imgHeight);
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text("Foto nicht verfügbar", x + 20, y + 30);
        doc.setTextColor(0);
      }

      if (photo.caption) {
        doc.setFontSize(7);
        doc.setTextColor(100);
        doc.text(doc.splitTextToSize(photo.caption, imgWidth)[0], x, y + imgHeight + 4);
        doc.setTextColor(0);
      }

      col++;
      if (col >= 2) {
        col = 0;
        y += imgHeight + (photo.caption ? 10 : 6);
      }
    }

    if (col !== 0) {
      y += imgHeight + 10;
    }
  }

  // Unterschriften - neue Seite wenn nötig
  if (y > 220) {
    doc.addPage();
    y = 20;
  } else {
    y = Math.max(y + 10, 220);
  }

  doc.setDrawColor(220);
  doc.line(14, y, pageWidth - 14, y);
  y += 8;
  doc.setFontSize(10);

  doc.setFont("helvetica", "bold");
  doc.text("Service-Techniker:", 14, y);
  doc.setFont("helvetica", "normal");
  doc.text(report.technician_name || "-", 14, y + 5);

  // Techniker Signatur
  if (signatures.tech) {
    try {
      doc.addImage(signatures.tech, "PNG", 14, y + 8, 60, 10);
    } catch {}
  }

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

  // Kunden Signatur
  if (signatures.client) {
    try {
      doc.addImage(signatures.client, "PNG", 110, y + 8, 60, 10);
    } catch {}
  }

  doc.line(110, y + 20, pageWidth - 14, y + 20);
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text("Unterschrift Kunde", 110, y + 24);

  // Footer auf jeder Seite
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setTextColor(150);
    doc.setFontSize(7);
    doc.text(
      "EVENTLINE GmbH · St. Jakobs-Strasse 200 · CH-4052 Basel · Tel: 055 556 62 61 · www.eventline-basel.com",
      pageWidth / 2, 285, { align: "center" }
    );
  }

  return Buffer.from(doc.output("arraybuffer"));
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id } = await params;
  // User-Client (mit Session-Cookie) fuer den initialen RLS-Check —
  // der User darf den Rapport nur invoicen wenn er ihn auch sehen darf.
  // Fuer Storage-Operationen + Update auf service_reports brauchen wir
  // anschliessend den Service-Role-Client.
  const userClient = await createClient();
  const supabase = createAdminClient();

  // Rapport mit Details laden — via User-Client damit RLS greift.
  const { data: report } = await userClient
    .from("service_reports")
    .select("*, job:jobs(title, job_number, verwaltungsaufwand, customer:customers(name, address_street, address_zip, address_city), location:locations(name))")
    .eq("id", id)
    .single();

  if (!report) {
    return NextResponse.json({ error: "Rapport nicht gefunden" }, { status: 404 });
  }

  const job = report.job as any;
  const customer = job?.customer;
  const location = job?.location;
  const jobNumber = job?.job_number || "?";
  const customerName = customer?.name || "Unbekannt";

  // Fotos laden
  const { data: reportPhotos } = await supabase
    .from("report_photos")
    .select("*")
    .eq("report_id", id)
    .order("sort_order");

  // Photo-Downloads parallel (vorher sequenziell = N x Storage-Latenz).
  // null-Werte raus, damit der Caller sich nicht um Fehlschlaege kuemmern muss.
  const photoImages = reportPhotos
    ? (await Promise.all(
        (reportPhotos as ReportPhoto[]).map(async (photo) => {
          try {
            const { data: fileData } = await supabase.storage.from("documents").download(photo.storage_path);
            if (!fileData) return null;
            const buffer = Buffer.from(await fileData.arrayBuffer());
            const ext = photo.storage_path.split(".").pop()?.toLowerCase() || "jpg";
            const mime = ext === "png" ? "image/png" : "image/jpeg";
            return {
              base64: `data:${mime};base64,${buffer.toString("base64")}`,
              caption: photo.caption,
            };
          } catch { return null; }
        }),
      )).filter((x): x is { base64: string; caption: string | null } => x !== null)
    : [];

  // Unterschriften laden
  const signatures: { tech: string | null; client: string | null } = { tech: null, client: null };

  if (report.technician_signature_url) {
    try {
      const { data } = await supabase.storage.from("documents").download(report.technician_signature_url);
      if (data) {
        const buffer = Buffer.from(await data.arrayBuffer());
        signatures.tech = `data:image/png;base64,${buffer.toString("base64")}`;
      }
    } catch {}
  }

  if (report.signature_url) {
    try {
      const { data } = await supabase.storage.from("documents").download(report.signature_url);
      if (data) {
        const buffer = Buffer.from(await data.arrayBuffer());
        signatures.client = `data:image/png;base64,${buffer.toString("base64")}`;
      }
    } catch {}
  }

  // PDF generieren
  const pdfBuffer = await generatePDF(report, job, customer, location, photoImages, signatures);

  // PDF in Supabase Storage speichern
  const pdfPath = `rapporte/Rapport_${jobNumber}_${id}.pdf`;
  await supabase.storage.from("documents").upload(pdfPath, pdfBuffer, {
    contentType: "application/pdf",
    upsert: true,
  });

  await supabase.from("service_reports").update({ pdf_url: pdfPath }).eq("id", id);

  // Dokument am Auftrag
  const { data: existingDoc } = await supabase
    .from("documents")
    .select("id")
    .eq("storage_path", pdfPath)
    .single();

  if (!existingDoc) {
    const { data: adminProfile } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "admin")
      .limit(1)
      .single();

    if (adminProfile) {
      await supabase.from("documents").insert({
        name: `Einsatzrapport INT-${jobNumber}.pdf`,
        storage_path: pdfPath,
        file_size: pdfBuffer.length,
        mime_type: "application/pdf",
        job_id: report.job_id,
        uploaded_by: adminProfile.id,
      });
    }
  }

  // E-Mail-Versand entfernt — PDF wird nur am Auftrag in der documents-Tabelle
  // gespeichert und ist dort fuer alle Berechtigten abrufbar.
  return NextResponse.json({ success: true });
}
