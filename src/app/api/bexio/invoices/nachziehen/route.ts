import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { listRecentInvoices } from "@/lib/bexio";
import { getInvoicePdf } from "@/lib/bexio";
import { ENTITY_PREFIX } from "@/lib/nummern-format";
import { logError } from "@/lib/log";

// POST {} — Backfill fuer BEREITS abgerechnete Auftraege: matcht die
// Bexio-Rechnungen (1. INT-Nummer im Rechnungstitel, 2. exakte
// Rechnungsnummer) und
//   - laedt das Rechnungs-PDF in die Auftrags-Dokumente, wenn dort noch
//     keines liegt (idempotent — mehrfach ausfuehrbar),
//   - korrigiert die hinterlegte Rechnungsnummer, wenn der Titel-Match
//     eine andere document_nr zeigt (Bexio ist die Wahrheit).
// Kunden-Matches sind hier bewusst AUSSEN VOR (zu unsicher fuer einen
// automatischen Lauf). Nur lesende Bexio-Calls + PDF-Downloads.

export const maxDuration = 300;

export async function POST() {
  const auth = await requirePermission("abrechnung:edit");
  if (auth.error) return auth.error;

  try {
    const admin = createAdminClient();
    const [{ data: jobRows }, rechnungen] = await Promise.all([
      admin
        .from("jobs")
        .select("id, job_number, invoice_number")
        .not("invoiced_at", "is", null)
        .eq("is_deleted", false),
      listRecentInvoices(500),
    ]);
    const jobs = (jobRows ?? []) as { id: string; job_number: number | null; invoice_number: string | null }[];

    // Auftraege, die schon ein Rechnungs-PDF haben, ueberspringen.
    const { data: docRows } = await admin
      .from("documents")
      .select("job_id")
      .ilike("name", "Rechnung_%")
      .in("job_id", jobs.map((j) => j.id));
    const hatPdf = new Set(((docRows ?? []) as { job_id: string }[]).map((d) => d.job_id));

    const ergebnis: { jobNumber: number | null; nr: string; pdf: boolean; nummerKorrigiert: boolean }[] = [];
    const ohneMatch: (number | null)[] = [];

    // Chunks à 3 — jeder Treffer zieht ein PDF (~200 KB) aus Bexio.
    const offen = [...jobs];
    while (offen.length > 0) {
      const chunk = offen.splice(0, 3);
      await Promise.all(chunk.map(async (job) => {
        const titelMatch = job.job_number != null
          ? rechnungen.find((r) => `${r.title ?? ""} ${r.reference ?? ""}`.toLowerCase()
              .includes(`${ENTITY_PREFIX.job.toLowerCase()}-${job.job_number}`))
          : undefined;
        const nummerMatch = !titelMatch && job.invoice_number
          ? rechnungen.find((r) => String(r.document_nr).trim() === job.invoice_number!.trim())
          : undefined;
        const rechnung = titelMatch ?? nummerMatch;
        if (!rechnung) { ohneMatch.push(job.job_number); return; }

        let nummerKorrigiert = false;
        const echteNr = String(rechnung.document_nr).trim();
        if (titelMatch && job.invoice_number?.trim() !== echteNr && echteNr) {
          const { error } = await admin.from("jobs").update({ invoice_number: echteNr }).eq("id", job.id);
          if (!error) nummerKorrigiert = true;
        }

        let pdfOk = false;
        if (!hatPdf.has(job.id)) {
          try {
            const pdf = await getInvoicePdf(rechnung.id);
            if (pdf) {
              const buf = Buffer.from(pdf.content, "base64");
              const pfad = `jobs/${job.id}/${Date.now()}_Rechnung_${echteNr}.pdf`;
              const { error: upErr } = await admin.storage
                .from("documents")
                .upload(pfad, buf, { contentType: pdf.mime || "application/pdf" });
              if (!upErr) {
                const { error: insErr } = await admin.from("documents").insert({
                  name: `Rechnung_${echteNr}.pdf`,
                  storage_path: pfad,
                  file_size: buf.length,
                  mime_type: pdf.mime || "application/pdf",
                  job_id: job.id,
                  uploaded_by: auth.user.id,
                  folder: "Rechnungen",
                });
                if (insErr) await admin.storage.from("documents").remove([pfad]);
                else pdfOk = true;
              }
            }
          } catch (e) {
            logError("api.bexio.invoices.nachziehen.pdf", e, { jobId: job.id });
          }
        }
        ergebnis.push({ jobNumber: job.job_number, nr: echteNr, pdf: pdfOk, nummerKorrigiert });
      }));
    }

    return NextResponse.json({
      success: true,
      gematcht: ergebnis.length,
      pdfs: ergebnis.filter((e) => e.pdf).length,
      nummernKorrigiert: ergebnis.filter((e) => e.nummerKorrigiert).length,
      ohneMatch,
      details: ergebnis,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
