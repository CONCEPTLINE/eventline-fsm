// GET /api/partner/belegungsplan?start=ISO&end=ISO — Kalender des eigenen
// Standorts im Partnerportal (Recht partner:belegungsplan:view). end ist
// exklusiv; Zeitraum hoechstens KALENDER_ZEITRAUM_MAX_TAGE.
//
// Antwort { success, eintraege, uebernahmen, verfuegbarkeit, darfEintragen }
// (KalenderAntwort, src/lib/standort-kalender.ts):
//   - eigene Anfragen (src/lib/partner-anfrage.ts) mit Titel, Status, Kunde,
//     Zugeteilten und Link ins Portal; abgelehnte bleiben sichtbar.
//   - Standort mit Kalender (locations.partner_kalender): alle anderen
//     Auftraege am Standort mit Titel, Status, Kunde und Zugeteilten — ausser
//     solchen mit noch nicht unterschriebenem Ablauf (auftrag_ablauf,
//     Migration 385) —, die eigenen Termine und Programm-Termine
//     (standort_termine), die aufgeloesten Veranstaltungen (standort_serien),
//     «EVENTLINE uebernimmt» (standort_uebernahmen) und die Verfuegbarkeit
//     von EVENTLINE (nur Stufe + Text, ohne Namen/Gruende).
//   - Standort ohne Kalender: alles andere nur «belegt» — Zeitraum, ohne ID,
//     Titel, Nummer, Kunde oder Status (Leo 2026-10-15); keine Zusaetze.
// Stornierte fremde Eintraege fehlen ganz (der Tag ist frei).

import { NextRequest, NextResponse } from "next/server";
import { requirePartnerPortal, partnerFehler, interneNamen } from "@/lib/partner-portal-server";
import { istEigeneAnfrage } from "@/lib/partner-anfrage";
import {
  ablaufOffenLaden,
  istIsoDatum,
  kalenderJobsLaden,
  kalenderSortieren,
  kalenderTermineLaden,
  kalenderZuteilungenLaden,
  KALENDER_ZEITRAUM_MAX_TAGE,
  partnerKalenderEintraege,
  serieAufloesen,
  serienLaden,
  standortKalenderLaden,
  terminKalenderEintraege,
  uebernahmenLaden,
  zeitraumTage,
  type KalenderAntwort,
} from "@/lib/standort-kalender";
import { aktivePersonen, standortMitarbeiterIds, verfuegbarkeitBerechnen } from "@/lib/standort-verfuegbarkeit";
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
  const zr = zeitraumTage(start, end);
  if (!zr) return partnerFehler(`Ungültiger Zeitraum (höchstens ${KALENDER_ZEITRAUM_MAX_TAGE} Tage)`, 400);

  try {
    const standort = await standortKalenderLaden(gate.admin, gate.standortId);
    const kalender = standort?.partner_kalender === true;
    const darfEintragen = kalender && gate.darf("partner:belegungsplan:edit");

    const [jobs, termine, serien, uebernahmen, mitarbeiterIds] = await Promise.all([
      kalenderJobsLaden(gate.admin, gate.standortId, start, end),
      kalender ? kalenderTermineLaden(gate.admin, gate.standortId, start, end) : Promise.resolve([]),
      kalender ? serienLaden(gate.admin, gate.standortId, zr.vonTag, zr.bisTag) : Promise.resolve([]),
      kalender ? uebernahmenLaden(gate.admin, gate.standortId, zr.vonTag, zr.bisTag) : Promise.resolve([]),
      kalender ? standortMitarbeiterIds(gate.admin, gate.standortId) : Promise.resolve([] as string[]),
    ]);

    // Fremde Auftraege mit offenem (nicht unterschriebenem) Ablauf ausblenden.
    const fremde = jobs.filter((j) => !istEigeneAnfrage(j, gate) && j.status !== "storniert").map((j) => j.id);
    const ausblenden = await ablaufOffenLaden(gate.admin, fremde);

    // Zugeteilte nur fuer Eintraege mit Details: eigene Anfragen, mit
    // Kalender auch die uebrigen sichtbaren, nicht stornierten Auftraege.
    const mitDetails = jobs
      .filter((j) => istEigeneAnfrage(j, gate) || (kalender && j.status !== "storniert" && !ausblenden.has(j.id)))
      .map((j) => j.id);
    const [zuteilungen, personen] = await Promise.all([
      kalenderZuteilungenLaden(gate.admin, mitDetails),
      aktivePersonen(gate.admin, mitarbeiterIds),
    ]);
    const [namen, verfuegbarkeit] = await Promise.all([
      interneNamen(gate.admin, zuteilungen.map((t) => t.assigned_to)),
      verfuegbarkeitBerechnen(gate.admin, gate.standortId, personen, zr.vonTag, zr.bisTag, { partnersicht: true }),
    ]);

    const antwort: KalenderAntwort = {
      eintraege: kalenderSortieren([
        ...partnerKalenderEintraege(jobs, gate, zuteilungen, namen, { kalender, ausblenden }),
        ...terminKalenderEintraege(termine, darfEintragen),
        ...serien.flatMap((s) => serieAufloesen(s, zr.vonTag, zr.bisTag, darfEintragen)),
      ]),
      uebernahmen,
      verfuegbarkeit,
    };
    return NextResponse.json({ success: true, ...antwort, darfEintragen });
  } catch (e) {
    logError("api.partner.belegungsplan", e);
    return partnerFehler("Belegungsplan konnte nicht geladen werden", 500);
  }
}
