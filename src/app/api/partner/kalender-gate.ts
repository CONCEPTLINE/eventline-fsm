// Gemeinsames Gate der Partner-Kalender-Routen (kein Route Handler — nur
// route.ts-Dateien sind oeffentlich): requirePartnerPortal + Recht +
// Standort mit Kalender (locations.partner_kalender). Standort immer aus der
// Sitzung, nie aus der Anfrage.

import type { NextResponse } from "next/server";
import { requirePartnerPortal, partnerFehler, type PartnerPortalKontext } from "@/lib/partner-portal-server";
import { standortKalenderLaden, type StandortKalenderInfo } from "@/lib/standort-kalender";
import { logError } from "@/lib/log";

export type PartnerKalenderGate =
  | { antwort: NextResponse; gate?: never; standort?: never }
  | { antwort: null; gate: PartnerPortalKontext; standort: StandortKalenderInfo };

export async function partnerKalenderGate(recht: "partner:belegungsplan:view" | "partner:belegungsplan:edit"): Promise<PartnerKalenderGate> {
  const gate = await requirePartnerPortal();
  if (gate.error) return { antwort: gate.error };
  if (!gate.darf(recht)) {
    return { antwort: partnerFehler(recht.endsWith(":edit") ? "Keine Berechtigung für diese Aktion" : "Kein Zugriff", 403) };
  }
  try {
    const standort = await standortKalenderLaden(gate.admin, gate.standortId);
    if (!standort?.partner_kalender) {
      return { antwort: partnerFehler("Der Kalender ist für diesen Standort nicht freigeschaltet", 403) };
    }
    return { antwort: null, gate, standort };
  } catch (e) {
    logError("api.partner.kalender-gate", e);
    return { antwort: partnerFehler("Laden fehlgeschlagen", 500) };
  }
}
