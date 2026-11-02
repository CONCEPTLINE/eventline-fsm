// GET /api/jobs/[id]/catering/pdf?art=vertrag-a|vertrag-b|karte — PDFs zum Getränke-Catering.
//
// Verträge nutzen das beim Speichern eingefrorene Ergebnis (job_catering.ergebnis), die Karte die
// AKTUELLE Getränkekarte (catering_getraenke). Ohne gespeicherte Kalkulation gibt es keine Verträge (409).
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { ladeGespeichert, ladeJobKontext, ladeKarte } from "@/lib/catering/daten";
import { karteTitel, kartePdf, vertragPdf } from "@/lib/catering/pdf";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const art = req.nextUrl.searchParams.get("art");
  if (art !== "vertrag-a" && art !== "vertrag-b" && art !== "karte") return fehler("Unbekannte Art");

  try {
    const admin = createAdminClient();
    const job = await ladeJobKontext(admin, jobId);
    if (!job) return fehler("Auftrag nicht gefunden", 404);
    const nr = job.jobNumber != null ? `INT-${job.jobNumber}` : "Auftrag";

    let bytes: Uint8Array;
    let name: string;
    if (art === "karte") {
      const g = await ladeGespeichert(admin, jobId);
      bytes = await kartePdf(await ladeKarte(admin), karteTitel(job, g?.anlass));
      name = `${nr}_Getraenkekarte.pdf`;
    } else {
      const g = await ladeGespeichert(admin, jobId);
      if (!g) return fehler("Zuerst die Kalkulation speichern", 409);
      const e = g.ergebnis;
      bytes = await vertragPdf({
        art: art === "vertrag-a" ? "A" : "B",
        job,
        eingabe: g.eingabe,
        ergebnis: { kraefte: e.kraefte, fixpreis: e.fixpreis, mindestumsatz: e.mindestumsatz, inbegriffen: e.inbegriffen },
        ausschankBeginn: g.ausschankBeginn,
        auftraggeber: job.auftraggeber,
        auftraggeberAdresse: job.auftraggeberAdresse,
        anlass: g.anlass,
      });
      name = `${nr}_Vertrag_${art === "vertrag-a" ? "A_Fixpreis" : "B_Mindestumsatz"}.pdf`;
    }
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    logError("catering.pdf", e);
    return fehler("PDF konnte nicht erstellt werden", 500);
  }
}
