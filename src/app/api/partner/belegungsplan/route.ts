// GET /api/partner/belegungsplan?start=ISO&end=ISO — Belegungsplan (Kalender)
// des eigenen Standorts im Partnerportal (Recht partner:belegungsplan:view).
//
// Antwort { success, eintraege: KalenderEintrag[], darfEintragen }
// (src/lib/standort-kalender.ts):
//   - eigene Anfragen (src/lib/partner-anfrage.ts) mit Titel, Status, Kunde,
//     Zugeteilten und Link ins Portal; abgelehnte bleiben sichtbar.
//   - Standort mit Kalender (locations.partner_kalender): alle anderen
//     Auftraege am Standort mit Titel, Status, Kunde und Zugeteilten, dazu die
//     eigenen Termine des Standorts (standort_termine, Migration 382).
//   - Standort ohne Kalender: alles andere nur «belegt» — Zeitraum, ohne ID,
//     Titel, Nummer, Kunde oder Status (Leo 2026-10-15).
// Stornierte fremde Eintraege fehlen ganz (der Tag ist frei).

import { NextRequest, NextResponse } from "next/server";
import { requirePartnerPortal, partnerFehler, interneNamen } from "@/lib/partner-portal-server";
import { istEigeneAnfrage } from "@/lib/partner-anfrage";
import {
  istIsoDatum,
  kalenderJobsLaden,
  kalenderSortieren,
  kalenderTermineLaden,
  kalenderZuteilungenLaden,
  partnerKalenderEintraege,
  terminKalenderEintraege,
} from "@/lib/standort-kalender";
import { logError } from "@/lib/log";

export async function GET(req: NextRequest) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darf("partner:belegungsplan:view")) return partnerFehler("Kein Zugriff", 403);

  const start = req.nextUrl.searchParams.get("start");
  const end = req.nextUrl.searchParams.get("end");
  // start/end landen im .or()-Filter — nur echte ISO-Daten zulassen.
  if (!istIsoDatum(start) || !istIsoDatum(end)) {
    return partnerFehler("start und end muessen ISO-Daten sein", 400);
  }

  try {
    const { data: standort, error: sErr } = await gate.admin
      .from("locations")
      .select("partner_kalender")
      .eq("id", gate.standortId)
      .maybeSingle();
    if (sErr) throw sErr;
    const kalender = (standort as { partner_kalender: boolean | null } | null)?.partner_kalender === true;
    const darfEintragen = kalender && gate.darf("partner:belegungsplan:edit");

    const [jobs, termine] = await Promise.all([
      kalenderJobsLaden(gate.admin, gate.standortId, start, end),
      kalender ? kalenderTermineLaden(gate.admin, gate.standortId, start, end) : Promise.resolve([]),
    ]);

    // Zugeteilte nur fuer Eintraege mit Details: eigene Anfragen, mit
    // Kalender auch die uebrigen nicht stornierten Auftraege.
    const mitDetails = jobs
      .filter((j) => istEigeneAnfrage(j, gate) || (kalender && j.status !== "storniert"))
      .map((j) => j.id);
    const zuteilungen = await kalenderZuteilungenLaden(gate.admin, mitDetails);
    const namen = await interneNamen(gate.admin, zuteilungen.map((t) => t.assigned_to));

    const eintraege = kalenderSortieren([
      ...partnerKalenderEintraege(jobs, gate, zuteilungen, namen, { kalender }),
      ...terminKalenderEintraege(termine, darfEintragen),
    ]);
    return NextResponse.json({ success: true, eintraege, darfEintragen });
  } catch (e) {
    logError("api.partner.belegungsplan", e);
    return partnerFehler("Belegungsplan konnte nicht geladen werden", 500);
  }
}
