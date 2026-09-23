// GET /api/cron/bexio-offerten
//
// Stuendlicher Cron (Vercel "0 * * * *"): holt die neuesten Bexio-Offerten
// und legt ihr PDF automatisch in die Dokumente des passenden Auftrags
// (Ordner "Offerten").
//
// Match: AUSSCHLIESSLICH ueber die Auftragsnummer im Offerten-Titel oder
// der Referenz ("INT-26262") — kein Kunden-Match (Lehre aus dem
// Rechnungs-Fall INT-26309/RE-26-144: Kunden-Matches sind zu unsicher
// fuer automatische Laeufe). Entwuerfe (Status 1) werden uebersprungen —
// erst eine versendete/bestaetigte Offerte landet im Auftrag.
//
// Idempotenz: pro Auftrag + Offerten-Nummer genau ein Dokument
// ("Offerte_<nr>.pdf") — existiert es schon, wird uebersprungen. So laeuft
// der Cron risikofrei stuendlich.
//
// Scope-Gate: aeltere Bexio-Verbindungen haben kb_offer_show noch nicht.
// Dann kommt {skipped: "scope"} zurueck (kein Fehler — sonst wuerde der
// Cron dauernd rot), bis in Einstellungen > Integrationen neu verbunden
// wurde. Nur lesende Bexio-Calls.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConnection, hasOfferScope, listRecentOffers, getOfferPdf } from "@/lib/bexio";
import { ENTITY_PREFIX } from "@/lib/nummern-format";
import { logError } from "@/lib/log";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const conn = await getConnection();
    if (!conn) return NextResponse.json({ success: true, skipped: "nicht verbunden" });
    if (!hasOfferScope(conn)) return NextResponse.json({ success: true, skipped: "scope" });

    const offers = (await listRecentOffers(100)).filter((o) => o.kb_item_status_id !== 1);

    // INT-Nummern aus Titel/Referenz ziehen und NUR diese Auftraege laden —
    // skaliert unabhaengig von der Gesamtzahl Auftraege (CLAUDE.md §4).
    const prefix = ENTITY_PREFIX.job.toLowerCase();
    const nummernRe = new RegExp(`${prefix}-(\\d{3,7})`, "gi");
    const kandidaten: { offer: (typeof offers)[number]; jobNumber: number }[] = [];
    const jobNumbers = new Set<number>();
    for (const o of offers) {
      const text = `${o.title ?? ""} ${o.reference ?? ""}`;
      for (const m of text.matchAll(nummernRe)) {
        const nr = Number(m[1]);
        if (!Number.isFinite(nr)) continue;
        kandidaten.push({ offer: o, jobNumber: nr });
        jobNumbers.add(nr);
      }
    }
    if (kandidaten.length === 0) return NextResponse.json({ success: true, gematcht: 0, pdfs: 0 });

    const admin = createAdminClient();
    const { data: jobRows } = await admin
      .from("jobs")
      .select("id, job_number")
      .in("job_number", [...jobNumbers])
      .eq("is_deleted", false);
    const jobByNumber = new Map(
      ((jobRows ?? []) as { id: string; job_number: number }[]).map((j) => [j.job_number, j.id]),
    );

    // Schon vorhandene Offerten-Dokumente der betroffenen Auftraege.
    const jobIds = [...new Set([...jobByNumber.values()])];
    const { data: docRows } = jobIds.length
      ? await admin.from("documents").select("job_id, name").ilike("name", "Offerte_%").in("job_id", jobIds)
      : { data: [] as { job_id: string; name: string }[] };
    const vorhanden = new Set(
      ((docRows ?? []) as { job_id: string; name: string }[]).map((d) => `${d.job_id}|${d.name}`),
    );

    const ergebnis: { jobNumber: number; nr: string; pdf: boolean }[] = [];
    // Chunks a 3 — jeder Treffer zieht ein PDF (~200 KB) aus Bexio.
    const offen = kandidaten.filter((k) => {
      const jobId = jobByNumber.get(k.jobNumber);
      if (!jobId) return false;
      return !vorhanden.has(`${jobId}|Offerte_${String(k.offer.document_nr).trim()}.pdf`);
    });
    while (offen.length > 0) {
      const chunk = offen.splice(0, 3);
      await Promise.all(chunk.map(async ({ offer, jobNumber }) => {
        const jobId = jobByNumber.get(jobNumber)!;
        const nr = String(offer.document_nr).trim();
        try {
          const pdf = await getOfferPdf(offer.id);
          if (!pdf) return;
          const buf = Buffer.from(pdf.content, "base64");
          const dateiName = `Offerte_${nr}.pdf`;
          const pfad = `jobs/${jobId}/${Date.now()}_${dateiName}`;
          const { error: upErr } = await admin.storage
            .from("documents")
            .upload(pfad, buf, { contentType: pdf.mime || "application/pdf" });
          if (upErr) {
            logError("api.cron.bexio-offerten.upload", upErr, { jobId, offerId: offer.id });
            return;
          }
          const { error: insErr } = await admin.from("documents").insert({
            name: dateiName,
            storage_path: pfad,
            file_size: buf.length,
            mime_type: pdf.mime || "application/pdf",
            job_id: jobId,
            uploaded_by: conn.connected_by,
            folder: "Offerten",
          });
          if (insErr) {
            await admin.storage.from("documents").remove([pfad]);
            logError("api.cron.bexio-offerten.doc-insert", insErr, { jobId, offerId: offer.id });
            return;
          }
          ergebnis.push({ jobNumber, nr, pdf: true });
        } catch (e) {
          logError("api.cron.bexio-offerten.pdf", e, { jobId, offerId: offer.id });
        }
      }));
    }

    return NextResponse.json({ success: true, gematcht: ergebnis.length, pdfs: ergebnis.length, details: ergebnis });
  } catch (e) {
    logError("api.cron.bexio-offerten", e);
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
