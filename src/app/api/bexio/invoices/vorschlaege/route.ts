import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { listRecentInvoices, getConnection } from "@/lib/bexio";
import { ENTITY_PREFIX } from "@/lib/nummern-format";

// POST {} — Bexio-Rechnungs-Vorschlaege fuer die Abrechnung.
//
// Fuer alle offenen Abrechnungs-Auftraege (abgeschlossen, noch nicht
// verrechnet/uebersprungen) werden die neuesten Bexio-Rechnungen
// zugeordnet:
//   (1) Titel/Referenz enthaelt "INT-<job_number>" -> sicherer Match
//       (das Team stellt Rechnungen in Bexio mit dem Auftrags-Kuerzel)
//   (2) sonst: Rechnung an denselben Bexio-Kontakt wie der Kunde
// Bereits am Auftrag hinterlegte Rechnungsnummern und Bexio-Entwuerfe
// (Status 7) werden ausgeklammert. Nur lesende Bexio-Calls.

export const maxDuration = 60;

interface JobRow {
  id: string;
  job_number: number | null;
  start_date: string | null;
  end_date: string | null;
  customer: { bexio_contact_id: string | null } | { bexio_contact_id: string | null }[] | null;
}

export async function POST() {
  const auth = await requirePermission("abrechnung:edit");
  if (auth.error) return auth.error;

  try {
    const conn = await getConnection();
    if (!conn) return NextResponse.json({ success: true, connected: false, vorschlaege: {} });

    const admin = createAdminClient();
    const [{ data: jobRows }, rechnungen] = await Promise.all([
      admin
        .from("jobs")
        .select("id, job_number, start_date, end_date, customer:customers(bexio_contact_id)")
        .eq("status", "abgeschlossen")
        .is("invoiced_at", null)
        .is("invoice_skipped_at", null)
        .eq("is_deleted", false),
      listRecentInvoices(150),
    ]);
    const jobs = (jobRows ?? []) as JobRow[];
    if (jobs.length === 0) return NextResponse.json({ success: true, connected: true, vorschlaege: {} });

    // Rechnungsnummern, die schon an irgendeinem Auftrag hinterlegt sind.
    const nummern = rechnungen.map((r) => r.document_nr).filter(Boolean);
    const { data: verwendetRows } = nummern.length
      ? await admin.from("jobs").select("invoice_number").in("invoice_number", nummern)
      : { data: [] as { invoice_number: string }[] };
    const verwendet = new Set(((verwendetRows ?? []) as { invoice_number: string }[]).map((r) => r.invoice_number));

    const kandidatenRechnungen = rechnungen.filter(
      (r) => r.kb_item_status_id !== 7 && !verwendet.has(r.document_nr),
    );

    type Vorschlag = {
      invoiceId: number;
      nr: string;
      titel: string | null;
      total: number;
      datum: string;
      matchArt: "auftrag" | "kunde";
    };
    const vorschlaege: Record<string, Vorschlag[]> = {};
    const push = (jobId: string, v: Vorschlag) => {
      const list = (vorschlaege[jobId] ??= []);
      if (list.length < 3 && !list.some((x) => x.invoiceId === v.invoiceId)) list.push(v);
    };

    for (const r of kandidatenRechnungen) {
      const text = `${r.title ?? ""} ${r.reference ?? ""}`.toLowerCase();
      const zuVorschlag = (matchArt: "auftrag" | "kunde"): Vorschlag => ({
        invoiceId: r.id,
        nr: r.document_nr,
        titel: r.title ?? null,
        total: Number(r.total) || 0,
        datum: r.is_valid_from,
        matchArt,
      });
      // (1) INT-Nummer im Titel/der Referenz.
      const nummerJob = jobs.find(
        (j) => j.job_number != null && text.includes(`${ENTITY_PREFIX.job.toLowerCase()}-${j.job_number}`),
      );
      if (nummerJob) {
        push(nummerJob.id, zuVorschlag("auftrag"));
        continue;
      }
      // (2) Kunden-Match ueber bexio_contact_id — NUR mit Datums-
      // Plausibilitaet: Rechnungen entstehen am/nach dem Event. Eine
      // Maerz-Rechnung darf nie fuer einen September-Auftrag
      // vorgeschlagen werden (Leo 2026-09-23, Fall INT-26309/RE-26-144).
      // Fenster: ab Auftrags-Start bis 60 Tage nach Auftrags-Ende;
      // ohne Auftrags-Daten kein Kunden-Match (zu unsicher).
      if (r.contact_id != null && r.is_valid_from) {
        // jobs.start_date/end_date sind timestamptz ("2026-09-22T00:00:00+00:00"),
        // Bexios is_valid_from ist ein reines Datum ("2026-09-22") — beide auf
        // den Tag normalisieren, sonst ist das zusammengesetzte Datum ungueltig
        // und .toISOString() wirft ("Invalid time value" -> ganze Route 502).
        const tag = (d: string) => d.slice(0, 10);
        const rechnungsTag = tag(r.is_valid_from);
        for (const j of jobs) {
          if (!j.start_date) continue;
          const von = tag(j.start_date);
          const bis = tag(j.end_date ?? j.start_date);
          const bisMs = new Date(bis + "T00:00:00Z").getTime();
          if (Number.isNaN(bisMs)) continue;
          const spaetestens = new Date(bisMs + 60 * 86_400_000).toISOString().slice(0, 10);
          if (rechnungsTag < von || rechnungsTag > spaetestens) continue;
          const cust = Array.isArray(j.customer) ? j.customer[0] : j.customer;
          if (cust?.bexio_contact_id && String(r.contact_id) === String(cust.bexio_contact_id)) {
            push(j.id, zuVorschlag("kunde"));
          }
        }
      }
    }

    // Sichere Matches zuerst.
    for (const list of Object.values(vorschlaege)) {
      list.sort((a, b) => (a.matchArt === b.matchArt ? 0 : a.matchArt === "auftrag" ? -1 : 1));
    }

    return NextResponse.json({ success: true, connected: true, vorschlaege });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
