import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
// jsPDF wird lazy in generatePDF() geladen — ~180KB nicht im Cold-Start.
import LOGO_BASE64 from "@/lib/logo-base64";
import { requireUser } from "@/lib/api-auth";
import { loadCompanySettings, formatAddressLine, formatFullFooter } from "@/lib/company-settings";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { logError } from "@/lib/log";
import type { RapportReportRow, RapportJobInfo } from "@/lib/build-rapport-pdf";

// Lokal-Typ fuer den Sub-Set der Range-Felder, die diese Route rendert.
// Deckt sich mit dem in build-rapport-pdf.ts — nur die vom PDF genutzten
// Felder sind pflichtig.
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
  report: RapportReportRow,
  job: RapportJobInfo | null,
  customer: RapportJobInfo["customer"] | null,
  location: RapportJobInfo["location"] | null,
  photos: { base64: string; caption: string | null }[],
  signatures: { tech: string | null; client: string | null },
  footerText: string,
  absenderZeile: string,
): Promise<Buffer> {
  const timeRanges: TimeRange[] = (report.time_ranges as TimeRange[] | null) ?? [];
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

  // Absender-Adresse unter dem Logo, rechtsbuendig an derselben Kante
  // (identisch zu lib/build-rapport-pdf — die beiden Generatoren muessen
  // dasselbe Kopf-Layout liefern).
  if (absenderZeile) {
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(absenderZeile, pageWidth - 14, 33, { align: "right" });
    doc.setTextColor(0);
  }

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
  // Trennlinie unterhalb von Titelblock UND Absender-Adresse.
  if (absenderZeile) y = Math.max(y, 37);
  doc.setDrawColor(220);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageWidth - 14, y);

  // Auftragsdaten — Werte getrimmt (fuehrende Leerzeichen in Stammdaten
  // schieben die Werte-Spalte sonst sichtbar aus der Flucht).
  y += 8;
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("Auftrag:", 14, y);
  doc.setFont("helvetica", "normal");
  doc.text((job?.title ?? "").trim() || "-", 55, y);

  y += 6;
  doc.setFont("helvetica", "bold");
  doc.text("Kunde:", 14, y);
  doc.setFont("helvetica", "normal");
  // Standort-Auftraege haben keinen customer — dann faellt "Kunde" auf den Standort
  // zurueck (analog Auftrag-Header).
  doc.text((customer?.name ?? location?.name ?? "").trim() || "-", 55, y);
  if (customer?.address_street?.trim()) {
    y += 5;
    const ortZeile = [customer.address_zip, customer.address_city]
      .map((t) => (t ?? "").trim())
      .filter(Boolean)
      .join(" ");
    doc.text([customer.address_street.trim(), ortZeile].filter(Boolean).join(", "), 55, y);
  }

  if (customer?.name && location?.name) {
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.text("Standort:", 14, y);
    doc.setFont("helvetica", "normal");
    doc.text(location.name.trim(), 55, y);
  }

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
  const vText = String(job?.verwaltungsaufwand ?? "").trim();
  const vMin = Number(job?.verwaltungsaufwand_minutes ?? 0) || 0;
  if (vText || vMin > 0) {
    y += 8;
    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Verwaltungsaufwand", 14, y);
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
  doc.text((report.technician_name ?? "").trim() || "-", 14, y + 5);

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
  if (report.client_absent) {
    // Bewusst ohne Kundenunterschrift (niemand vor Ort) — explizit
    // ausweisen statt eine leere Unterschriftslinie zu drucken.
    doc.setFont("helvetica", "italic");
    doc.setTextColor(120);
    doc.setFontSize(9);
    const absentLines = doc.splitTextToSize(
      "Kunde nicht vor Ort — Rapport ohne Kundenunterschrift abgeschlossen.",
      pageWidth - 14 - 110,
    );
    doc.text(absentLines, 110, y + 5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(0);
  } else {
    doc.setFont("helvetica", "normal");
    doc.text((report.client_name ?? "").trim() || "-", 110, y + 5);

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
  }

  // Footer auf jeder Seite
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setTextColor(150);
    doc.setFontSize(7);
    doc.text(
      footerText,
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
    .select("*, job:jobs(title, job_number, verwaltungsaufwand, verwaltungsaufwand_minutes, customer:customers(name, address_street, address_zip, address_city), location:locations(name))")
    .eq("id", id)
    .single();

  if (!report) {
    return NextResponse.json({ error: "Rapport nicht gefunden" }, { status: 404 });
  }

  const typedReport = report as RapportReportRow;
  const job = (report.job as RapportJobInfo | null) ?? null;
  const customer = job?.customer ?? null;
  const location = job?.location ?? null;
  const jobNumber = job?.job_number ?? "?";

  // Signatur-Download-Helfer (PNG als data-URI, Fehlschlag → null).
  const loadSignature = async (path: string | null | undefined): Promise<string | null> => {
    if (!path) return null;
    try {
      const { data } = await supabase.storage.from("documents").download(path);
      if (!data) return null;
      const buffer = Buffer.from(await data.arrayBuffer());
      return `data:image/png;base64,${buffer.toString("base64")}`;
    } catch { return null; }
  };

  // Fotos + beide Unterschriften + Company-Settings parallel laden
  // (vorher sequenziell = N x Storage-/DB-Latenz).
  const [photoImages, techSignature, clientSignature, company] = await Promise.all([
    (async () => {
      const { data: reportPhotos } = await supabase
        .from("report_photos")
        .select("*")
        .eq("report_id", id)
        .order("sort_order");
      if (!reportPhotos) return [] as { base64: string; caption: string | null }[];
      // Photo-Downloads parallel. null-Werte raus, damit der Caller sich
      // nicht um Fehlschlaege kuemmern muss.
      return (await Promise.all(
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
      )).filter((x): x is { base64: string; caption: string | null } => x !== null);
    })(),
    loadSignature(report.technician_signature_url),
    loadSignature(report.signature_url),
    loadCompanySettings(supabase),
  ]);

  const signatures: { tech: string | null; client: string | null } = {
    tech: techSignature,
    client: clientSignature,
  };

  // PDF generieren
  const pdfBuffer = await generatePDF(typedReport, job, customer, location, photoImages, signatures, formatFullFooter(company), formatAddressLine(company));

  // PDF in Supabase Storage speichern — Fehler HART machen, sonst
  // meldet der Client "success" obwohl das PDF nirgends abgelegt ist.
  const pdfPath = `rapporte/Rapport_${jobNumber}_${id}.pdf`;
  const { error: uploadErr } = await supabase.storage.from("documents").upload(pdfPath, pdfBuffer, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (uploadErr) {
    logError("reports.send-invoice.upload", uploadErr, { reportId: id, pdfPath });
    return NextResponse.json({ success: false, error: `PDF-Upload fehlgeschlagen: ${uploadErr.message}` }, { status: 500 });
  }

  const { error: updateErr } = await supabase.from("service_reports").update({ pdf_url: pdfPath }).eq("id", id);
  if (updateErr) {
    logError("reports.send-invoice.update", updateErr, { reportId: id });
    return NextResponse.json({ success: false, error: `Rapport-Update fehlgeschlagen: ${updateErr.message}` }, { status: 500 });
  }

  // Dokument am Auftrag verlinken. Existierender Doc-Row wird uebersprungen —
  // storage_path ist eindeutig. single()-Fehler NICHT als 500 werfen; PGRST116
  // ("no rows") ist hier der Normalfall beim Ersteinstellen.
  // Doc-Lookup + Empfaenger-Ermittlung sind unabhaengig → parallel.
  // uploaded_by: statt EINEM beliebigen Admin (.limit(1)) der erste
  // Empfaenger mit 'abrechnung:edit' (Admin-Rolle immer dabei) — so haengt
  // der Rapport an jemandem, der Abrechnungen tatsaechlich bearbeitet.
  const [{ data: existingDoc, error: existingErr }, abrechnungIds] = await Promise.all([
    supabase
      .from("documents")
      .select("id")
      .eq("storage_path", pdfPath)
      .maybeSingle(),
    recipientsWithPermission(supabase, "abrechnung:edit"),
  ]);
  if (existingErr) {
    logError("reports.send-invoice.doc-lookup", existingErr, { pdfPath });
  }

  if (!existingDoc) {
    const uploaderId = abrechnungIds[0] ?? null;

    if (uploaderId) {
      const jobId = (report as { job_id?: string | null }).job_id ?? null;
      const { error: docInsertErr } = await supabase.from("documents").insert({
        name: `Einsatzrapport INT-${jobNumber}.pdf`,
        storage_path: pdfPath,
        file_size: pdfBuffer.length,
        mime_type: "application/pdf",
        job_id: jobId,
        uploaded_by: uploaderId,
      });
      if (docInsertErr) {
        logError("reports.send-invoice.doc-insert", docInsertErr, { pdfPath });
        return NextResponse.json({ success: false, error: `Doc-Insert fehlgeschlagen: ${docInsertErr.message}` }, { status: 500 });
      }
    }
  }

  // E-Mail-Versand entfernt — PDF wird nur am Auftrag in der documents-Tabelle
  // gespeichert und ist dort fuer alle Berechtigten abrufbar.
  return NextResponse.json({ success: true });
}
