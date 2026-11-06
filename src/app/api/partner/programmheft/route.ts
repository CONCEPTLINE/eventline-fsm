// /api/partner/programmheft — Programmheft der Website (vorerst Barakuba,
// src/lib/programmheft.ts) mit dem Partner-Kalender abgleichen. Nur Standorte
// mit locations.partner_kalender.
//
// GET   (partner:belegungsplan:view) → { success, funde: ProgrammFund[], quelle, auto, abgeglichenAm }
// POST  (…:edit) { quelleIds: string[] } → { success, neu, aktualisiert } — liest die
//       Website erneut und uebernimmt nur die gewaehlten Funde als Programm-Termine
// PATCH (…:edit) { auto: boolean } → { success } — taeglicher Abgleich (Cron) an/aus
// Website-Probleme → 502 mit Klartext.

import { NextRequest, NextResponse } from "next/server";
import { partnerFehler } from "@/lib/partner-portal-server";
import { autoPruefen, ProgrammheftFehler, programmheftImport, programmheftQuelle, programmheftStand, quelleIdsPruefen } from "@/lib/programmheft";
import { logError } from "@/lib/log";
import { partnerKalenderGate } from "../kalender-gate";

export async function GET() {
  const k = await partnerKalenderGate("partner:belegungsplan:view");
  if (k.antwort) return k.antwort;
  try {
    const stand = await programmheftStand(k.gate.admin, k.standort);
    return NextResponse.json({ success: true, ...stand });
  } catch (e) {
    if (e instanceof ProgrammheftFehler) return partnerFehler(e.message, 502);
    logError("api.partner.programmheft.get", e);
    return partnerFehler("Programmheft konnte nicht geladen werden", 500);
  }
}

export async function POST(req: NextRequest) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  const p = quelleIdsPruefen(await req.json().catch(() => null));
  if (!p.ok) return partnerFehler(p.fehler, 400);
  try {
    const r = await programmheftImport(k.gate.admin, k.standort, k.gate.userId, p.ids);
    return NextResponse.json({ success: true, neu: r.neu, aktualisiert: r.aktualisiert });
  } catch (e) {
    if (e instanceof ProgrammheftFehler) return partnerFehler(e.message, 502);
    logError("api.partner.programmheft.post", e);
    return partnerFehler("Programm konnte nicht übernommen werden", 500);
  }
}

export async function PATCH(req: NextRequest) {
  const k = await partnerKalenderGate("partner:belegungsplan:edit");
  if (k.antwort) return k.antwort;
  const auto = autoPruefen(await req.json().catch(() => null));
  if (auto === null) return partnerFehler("Ungültige Angabe «auto»", 400);
  if (!programmheftQuelle(k.standort.name)) return partnerFehler("Für diesen Standort ist kein Programmheft hinterlegt", 404);
  try {
    const { error } = await k.gate.admin.from("locations").update({ programmheft_auto: auto }).eq("id", k.gate.standortId);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e) {
    logError("api.partner.programmheft.patch", e);
    return partnerFehler("Einstellung konnte nicht gespeichert werden", 500);
  }
}
