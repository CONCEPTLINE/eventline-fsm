// GET /api/jobs/[id]/catering/pdf?art=vertrag-a|vertrag-b|karte — PDFs zum Getränke-Catering.
//
// Verträge nutzen das beim Speichern eingefrorene Ergebnis (job_catering.ergebnis), die Karte die
// AKTUELLE Getränkekarte (catering_getraenke). Ohne gespeicherte Kalkulation gibt es keine Verträge (409).
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { UUID_RE, fehler } from "@/lib/catering/route-hilfen";
import { snapshotVollstaendig } from "@/lib/catering/rechnen";
import { ladeGespeichert, ladeJobKontext, ladeKarte } from "@/lib/catering/daten";
import { karteTitel, kartePdf, vertragPdf } from "@/lib/catering/pdf";


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
      if (!snapshotVollstaendig(e)) {
        return fehler("Die gespeicherte Kalkulation ist veraltet. Bitte im Reiter «Catering» neu speichern.", 409);
      }
      bytes = await vertragPdf({
        art: art === "vertrag-a" ? "A" : "B",
        job,
        eingabe: g.eingabe,
        ergebnis: {
          kraefte: e.kraefte, stundenProKraft: e.stundenProKraft, stundensatzA: e.stundensatzA, getraenkeA: e.getraenkeA,
          serviceA: e.serviceA, richtpreisA: e.richtpreisA, bestellmengeA: e.bestellmengeA, mindestumsatz: e.mindestumsatz,
        },
        ausschankBeginn: g.ausschankBeginn,
        auftraggeber: job.auftraggeber,
        auftraggeberAdresse: job.auftraggeberAdresse,
        anlass: g.anlass,
      });
      name = `${nr}_Vertrag_${art === "vertrag-a" ? "A_Bestellung" : "B_Mindestumsatz"}.pdf`;
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
