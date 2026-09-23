import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { getInvoiceById, getInvoicePdf } from "@/lib/bexio";

// GET /api/bexio/invoices/[id]/pdf — Bexio-Rechnungs-PDF zur Vorschau
// (Augen-Button am Vorschlag auf der Abrechnung, BEVOR uebernommen wird).
// Nur lesende Bexio-Calls; nichts wird am Auftrag veraendert.

export const maxDuration = 30;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePermission("abrechnung:edit");
  if (auth.error) return auth.error;

  const { id } = await params;
  const invoiceId = Number(id);
  if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
    return NextResponse.json({ error: "Ungültige Rechnungs-ID" }, { status: 400 });
  }

  try {
    const [rechnung, pdf] = await Promise.all([
      getInvoiceById(invoiceId),
      getInvoicePdf(invoiceId),
    ]);
    if (!pdf) {
      return NextResponse.json({ error: "Bexio-Rechnung nicht gefunden" }, { status: 404 });
    }
    const buf = Buffer.from(pdf.content, "base64");
    const nr = String(rechnung?.document_nr ?? invoiceId).trim();
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": pdf.mime || "application/pdf",
        "Content-Disposition": `inline; filename="Rechnung_${nr}.pdf"`,
        // Vorschau darf kurz gecacht werden — Rechnungs-PDFs aendern sich
        // praktisch nie, und der Bexio-Roundtrip ist der teure Teil.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
