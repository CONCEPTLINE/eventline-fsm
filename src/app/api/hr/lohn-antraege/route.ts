// Anträge zu Stempeln nach der Monatssperre (Phase 2/4, Migrationen 364/367).
//
// GET  /api/hr/lohn-antraege                 — offene + zuletzt entschiedene Anträge
//                                              (je mit darf_bestaetigen/hinderungsgrund)
// POST /api/hr/lohn-antraege  { id, aktion: "bestaetigen" | "ablehnen", grund? }
//
// Bestätigen: Lohnrecht + vertrautes Gerät, nicht der Antragsteller, nicht die
// betroffene Person, aktiver Admin oder Vertretung (prüft die DB-Funktion
// lohn_aenderung_ausfuehren erneut), innert 24 h, nicht in «Ansicht als».
// Ablehnen / eigenen Antrag zurückziehen: jede Person mit Lohnrecht.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ladeName } from "@/lib/lohn/rechte-antraege";
import { bestaetigeAntrag, ladeAntraege, lehneAntragAb, lohnHinderungsgrund as hinderungsgrund } from "@/lib/lohn/aenderungen";

export async function GET() {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  try {
    const alle = await ladeAntraege(createAdminClient());
    const mit = alle.map((a) => {
      const grund = hinderungsgrund(a, auth.user.id, auth.isImpersonating);
      return { ...a, darf_bestaetigen: grund === null, hinderungsgrund: grund, eigener: a.beantragt_von === auth.user.id };
    });
    return NextResponse.json({ success: true, offen: mit.filter((a) => a.status === "offen"), entschieden: mit.filter((a) => a.status !== "offen").slice(0, 20) });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const body = (await req.json().catch(() => null)) as { id?: unknown; aktion?: unknown; grund?: unknown } | null;
  const id = typeof body?.id === "string" && isUuid(body.id) ? body.id : null;
  const aktion = body?.aktion === "bestaetigen" || body?.aktion === "ablehnen" ? body.aktion : null;
  if (!id || !aktion) return NextResponse.json({ success: false, error: "id und aktion nötig" }, { status: 400 });
  if (auth.isImpersonating) return NextResponse.json({ success: false, error: "In «Ansicht als» nicht möglich" }, { status: 403 });
  const admin = createAdminClient();
  const name = await ladeName(admin, auth.user.id);
  try {
    if (aktion === "ablehnen") {
      await lehneAntragAb(admin, id, { id: auth.user.id, name }, typeof body?.grund === "string" ? body.grund.trim().slice(0, 500) || null : null);
      return NextResponse.json({ success: true });
    }
    await bestaetigeAntrag(admin, id, { id: auth.user.id, name });
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
