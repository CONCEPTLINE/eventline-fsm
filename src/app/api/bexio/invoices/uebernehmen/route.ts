import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { getInvoiceById, getInvoicePdf } from "@/lib/bexio";
import { logError } from "@/lib/log";

// POST { jobId, invoiceId } — bestaetigt einen Bexio-Rechnungs-Vorschlag:
// setzt "Rechnung gestellt" (invoiced_at/by + invoice_number, atomar wie
// /api/jobs/[id]/mark-invoiced) und laedt das Rechnungs-PDF aus Bexio in
// die Auftrags-Dokumente (Ordner "Rechnungen").
//
// Schlaegt NUR der PDF-Teil fehl, bleibt die Markierung bestehen und die
// Antwort sagt es ehrlich (pdfUebernommen: false) — die Nummer ist das
// fachlich Wichtige, das PDF laesst sich manuell nachschieben.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const auth = await requirePermission("abrechnung:edit");
  if (auth.error) return auth.error;

  const body = (await request.json().catch(() => null)) as { jobId?: string; invoiceId?: number } | null;
  const jobId = body?.jobId;
  const invoiceId = Number(body?.invoiceId);
  if (!jobId || !UUID_RE.test(jobId) || !Number.isFinite(invoiceId)) {
    return NextResponse.json({ success: false, error: "jobId + invoiceId nötig" }, { status: 400 });
  }

  try {
    const rechnung = await getInvoiceById(invoiceId);
    if (!rechnung) {
      return NextResponse.json({ success: false, error: "Bexio-Rechnung nicht gefunden" }, { status: 404 });
    }
    // Anders als bei der manuellen Eingabe (mark-invoiced: 1-5 Ziffern)
    // uebernehmen wir Bexios document_nr im Original — aeltere Rechnungen
    // heissen z.B. "RE-26-144", neuere "26057". Die Nummer kommt direkt
    // aus Bexio, nicht vom User getippt.
    const nr = String(rechnung.document_nr ?? "").trim();
    if (!nr || nr.length > 32) {
      return NextResponse.json(
        { success: false, error: "Bexio-Rechnungsnummer fehlt oder ist ungültig" },
        { status: 422 },
      );
    }

    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("jobs")
      .select("id, job_number, status, invoiced_at, is_deleted")
      .eq("id", jobId)
      .maybeSingle();
    if (!existing) return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });
    if (existing.is_deleted) return NextResponse.json({ success: false, error: "Auftrag ist gelöscht" }, { status: 400 });
    if (existing.status !== "abgeschlossen") {
      return NextResponse.json({ success: false, error: "Auftrag ist nicht abgeschlossen" }, { status: 400 });
    }
    if (existing.invoiced_at) {
      return NextResponse.json({ success: false, error: "Auftrag wurde bereits als abgerechnet markiert" }, { status: 400 });
    }

    // Atomar wie mark-invoiced: .is('invoiced_at', null) — bei zwei
    // parallelen Bestaetigungen gewinnt genau eine.
    const { error: updErr, count } = await admin
      .from("jobs")
      .update(
        { invoiced_at: new Date().toISOString(), invoice_number: nr, invoiced_by: auth.user.id },
        { count: "exact" },
      )
      .eq("id", jobId)
      .is("invoiced_at", null);
    if (updErr) {
      logError("api.bexio.invoices.uebernehmen", updErr, { jobId, invoiceId });
      return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
    }
    if (count === 0) {
      return NextResponse.json(
        { success: false, error: "Auftrag wurde inzwischen von jemand anderem als abgerechnet markiert" },
        { status: 409 },
      );
    }

    // PDF aus Bexio in die Auftrags-Dokumente (best effort).
    let pdfUebernommen = false;
    try {
      const pdf = await getInvoicePdf(invoiceId);
      if (pdf) {
        const buf = Buffer.from(pdf.content, "base64");
        const dateiName = `Rechnung_${nr}.pdf`;
        const pfad = `jobs/${jobId}/${Date.now()}_${dateiName}`;
        const { error: upErr } = await admin.storage
          .from("documents")
          .upload(pfad, buf, { contentType: pdf.mime || "application/pdf" });
        if (!upErr) {
          const { error: insErr } = await admin.from("documents").insert({
            name: dateiName,
            storage_path: pfad,
            file_size: buf.length,
            mime_type: pdf.mime || "application/pdf",
            job_id: jobId,
            uploaded_by: auth.user.id,
            folder: "Rechnungen",
          });
          if (insErr) {
            await admin.storage.from("documents").remove([pfad]);
            logError("api.bexio.invoices.uebernehmen.doc-insert", insErr, { jobId, invoiceId });
          } else {
            pdfUebernommen = true;
          }
        } else {
          logError("api.bexio.invoices.uebernehmen.upload", upErr, { jobId, invoiceId });
        }
      }
    } catch (pdfErr) {
      logError("api.bexio.invoices.uebernehmen.pdf", pdfErr, { jobId, invoiceId });
    }

    return NextResponse.json({ success: true, invoiceNumber: nr, pdfUebernommen });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
