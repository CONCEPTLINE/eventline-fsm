// GET /api/partner/belegungsplan?start=ISO&end=ISO — Belegungsplan des
// eigenen Standorts im Partnerportal (Recht partner:belegungsplan:view).
//
// Eigene Anfragen (src/lib/partner-anfrage.ts) kommen mit Titel, Status und
// den Namen der zugeteilten EVENTLINE-Mitarbeitenden. Alles andere am
// Standort (EVENTLINE-eigene Auftraege, Vermietungen) nur als «belegt»:
// Zeitraum, ohne ID, Titel, Nummer, Kunde oder Status (Leo 2026-10-15).
// Stornierte fremde Eintraege fehlen ganz (der Tag ist frei), abgelehnte
// eigene Anfragen bleiben sichtbar.

import { NextRequest, NextResponse } from "next/server";
import { requirePartnerPortal, partnerFehler, interneNamen } from "@/lib/partner-portal-server";
import { istEigeneAnfrage, partnerBelegungen, type AnfrageKern } from "@/lib/partner-anfrage";
import { logError } from "@/lib/log";

const ISO_DATUM_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

interface BelegungsZeile extends AnfrageKern {
  id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
}

export async function GET(req: NextRequest) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darf("partner:belegungsplan:view")) return partnerFehler("Kein Zugriff", 403);

  const start = req.nextUrl.searchParams.get("start");
  const end = req.nextUrl.searchParams.get("end");
  // start/end landen im .or()-Filter — nur echte ISO-Daten zulassen.
  if (!start || !end || !ISO_DATUM_RE.test(start) || !ISO_DATUM_RE.test(end)) {
    return partnerFehler("start und end muessen ISO-Daten sein", 400);
  }

  try {
    // Buchung beginnt vor Range-Ende UND endet im/nach Range-Anfang (mehrtaegige
    // Events, die vorher begannen, bleiben drin).
    const { data, error } = await gate.admin
      .from("jobs")
      .select("id, title, status, start_date, end_date, location_id, is_deleted, accepted_at, rejected_at, created_by")
      .eq("location_id", gate.standortId)
      .not("is_deleted", "is", true)
      .not("start_date", "is", null)
      .or(`and(start_date.lt.${end},or(end_date.gte.${start},and(end_date.is.null,start_date.gte.${start})))`)
      .order("start_date");
    if (error) throw error;
    const jobs = (data ?? []) as BelegungsZeile[];

    const eigeneIds = new Set(jobs.filter((j) => istEigeneAnfrage(j, gate)).map((j) => j.id));
    const { data: termine, error: tErr } = eigeneIds.size
      ? await gate.admin
          .from("job_appointments")
          .select("job_id, assigned_to")
          .in("job_id", [...eigeneIds])
          .order("start_time")
          .order("created_at")
      : { data: [], error: null };
    if (tErr) throw tErr;
    const zuteilungen = (termine ?? []) as { job_id: string; assigned_to: string | null }[];
    const namen = await interneNamen(gate.admin, zuteilungen.map((t) => t.assigned_to));

    const buchungen = partnerBelegungen(jobs, gate, zuteilungen, namen);
    return NextResponse.json({ success: true, buchungen });
  } catch (e) {
    logError("api.partner.belegungsplan", e);
    return partnerFehler("Belegungsplan konnte nicht geladen werden", 500);
  }
}
