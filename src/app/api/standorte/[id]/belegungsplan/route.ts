// GET /api/standorte/[id]/belegungsplan?start=ISO&end=ISO — interner
// Kalender eines Standorts (Recht locations:view, Admin immer). end ist
// exklusiv; Zeitraum hoechstens KALENDER_ZEITRAUM_MAX_TAGE.
//
// Antwort { success, eintraege, uebernahmen, verfuegbarkeit, darfEintragen }
// (KalenderAntwort, src/lib/standort-kalender.ts): alle nicht geloeschten,
// nicht stornierten Auftraege am Standort — «anfrage», wenn aus einer
// Partner-Anfrage entstanden, sonst «auftrag», Link /auftraege/<id> — plus
// eigene Termine/Programm-Termine (standort_termine), aufgeloeste
// Veranstaltungen (standort_serien), «EVENTLINE uebernimmt»
// (standort_uebernahmen) und die Verfuegbarkeit mit vollen Namen und
// Gruenden (src/lib/standort-verfuegbarkeit.ts). darfEintragen = Standort hat
// den Kalender (partner_kalender) UND locations:edit. Auftraege mit
// Vermietungs-Ablauf tragen `ablauf: { schritt, verborgen }` (nur hier, nie in
// der Partner-Antwort).
//
// Auftraege, Zuteilungen, Termine, Serien, Uebernahmen und die Einteilung
// (standort_mitarbeiter) laufen ueber den RLS-Client des Nutzers. Nur
// Personen-Namen, die Partner-Konten des Standorts (Regel «Partner-Anfrage»)
// und die Grundlagen der Verfuegbarkeit (Abwesenheiten, Einsaetze) kommen vom
// Admin-Client.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { interneNamen } from "@/lib/partner-portal-server";
import {
  ablaufStandLaden,
  internKalenderEintraege,
  istIsoDatum,
  kalenderJobsLaden,
  kalenderSortieren,
  kalenderTermineLaden,
  kalenderZuteilungenLaden,
  KALENDER_ZEITRAUM_MAX_TAGE,
  serieAufloesen,
  serienLaden,
  terminKalenderEintraege,
  uebernahmenLaden,
  zeitraumTage,
  type KalenderAntwort,
} from "@/lib/standort-kalender";
import { aktivePersonen, standortMitarbeiterIds, verfuegbarkeitBerechnen } from "@/lib/standort-verfuegbarkeit";
import { logError } from "@/lib/log";
import { internFehler, internKalenderGate } from "../kalender-gate";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: roh } = await params;
  const start = req.nextUrl.searchParams.get("start");
  const end = req.nextUrl.searchParams.get("end");
  const k = await internKalenderGate(roh, "locations:view");
  if (k.antwort) return k.antwort;
  const { supabase, standort } = k;
  const standortId = standort.id;

  // start/end landen im .or()-Filter — nur echte ISO-Daten zulassen.
  if (!istIsoDatum(start) || !istIsoDatum(end)) return internFehler("start und end muessen ISO-Daten sein", 400);
  const zr = zeitraumTage(start, end);
  if (!zr) return internFehler(`Ungültiger Zeitraum (höchstens ${KALENDER_ZEITRAUM_MAX_TAGE} Tage)`, 400);

  try {
    const admin = createAdminClient();
    const [rechtRes, grundRes] = await Promise.all([
      supabase.rpc("has_permission", { perm: "locations:edit" }),
      // Abwesenheitsgrund (Ferien/Krank …) nur fuer Berechtigte (Migration 379).
      supabase.rpc("darf_abwesenheitsgrund_sehen"),
    ]);
    if (rechtRes.error) throw rechtRes.error;
    const darfBearbeiten = rechtRes.data === true;
    // Fehler = sicher: dann nur «abwesend».
    const grundSichtbar = !grundRes.error && grundRes.data === true;
    const darfEintragen = standort.partner_kalender && darfBearbeiten;

    const [jobs, termine, serien, uebernahmen, mitarbeiterIds, partnerRes] = await Promise.all([
      kalenderJobsLaden(supabase, standortId, start, end),
      kalenderTermineLaden(supabase, standortId, start, end),
      serienLaden(supabase, standortId, zr.vonTag, zr.bisTag),
      uebernahmenLaden(supabase, standortId, zr.vonTag, zr.bisTag),
      standortMitarbeiterIds(supabase, standortId),
      admin.from("profiles").select("id, partner_location_id").eq("role", "partner"),
    ]);
    if (partnerRes.error) throw partnerRes.error;
    const partnerKonten = (partnerRes.data ?? []) as { id: string; partner_location_id: string | null }[];
    const partnerTeam = {
      standortId,
      teamIds: partnerKonten.filter((p) => p.partner_location_id === standortId).map((p) => p.id),
      fremdePartnerIds: partnerKonten.filter((p) => p.partner_location_id !== standortId).map((p) => p.id),
    };

    const sichtbar = jobs.filter((j) => j.status !== "storniert").map((j) => j.id);
    const [zuteilungen, personen, ablaeufe] = await Promise.all([
      kalenderZuteilungenLaden(supabase, sichtbar),
      aktivePersonen(admin, mitarbeiterIds),
      ablaufStandLaden(supabase, sichtbar),
    ]);
    const [namen, verfuegbarkeit] = await Promise.all([
      interneNamen(admin, zuteilungen.map((t) => t.assigned_to)),
      verfuegbarkeitBerechnen(admin, standortId, personen, zr.vonTag, zr.bisTag, { partnersicht: false, grundSichtbar }),
    ]);

    const antwort: KalenderAntwort = {
      eintraege: kalenderSortieren([
        ...internKalenderEintraege(jobs, partnerTeam, zuteilungen, namen).map((e) => ({ ...e, ablauf: ablaeufe.get(e.id) ?? null })),
        ...terminKalenderEintraege(termine, darfBearbeiten),
        ...serien.flatMap((s) => serieAufloesen(s, zr.vonTag, zr.bisTag, darfBearbeiten)),
      ]),
      uebernahmen,
      verfuegbarkeit,
    };
    return NextResponse.json({ success: true, ...antwort, darfEintragen });
  } catch (e) {
    logError("api.standorte.belegungsplan", e, { standortId });
    return internFehler("Belegungsplan konnte nicht geladen werden", 500);
  }
}
