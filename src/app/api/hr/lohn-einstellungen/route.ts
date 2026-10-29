// Lohn-Einstellungen (Lohn-Umbau Phase 1), Tabelle lohn_einstellungen.
//
// GET /api/hr/lohn-einstellungen  — Vertretung + «Lauf ab» (nur Admins)
// PUT /api/hr/lohn-einstellungen  — Body { vertretung_profile_id: uuid | null }
//                                    nur Admins auf vertrautem Gerät; stellt
//                                    einen ANTRAG (Vier Augen, Migration 359),
//                                    den der andere Admin bestätigt.
//
// Die Vertretung darf wie der andere Admin neue Geräte freigeben und den Lohn
// von Personen mit Lohnrecht ändern (Vier Augen) — nie den eigenen.

import { NextResponse } from "next/server";
import { requireAdmin, requireAdminTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ANTRAG_HINWEIS, ladeName, stelleRechteAntrag } from "@/lib/lohn/rechte-antraege";
import { LOHN_RECHT, ladeLohnEinstellungen } from "@/lib/lohn/zugriff";
import { monatSchluessel } from "@/lib/lohn/monate";
import { isUuid } from "@/lib/search-escape";
import { istIntern } from "@/lib/roles";

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const e = await ladeLohnEinstellungen(createAdminClient());
    return NextResponse.json({
      success: true,
      vertretung_profile_id: e.vertretungProfileId,
      vertretung_name: e.vertretungName,
      lauf_ab: monatSchluessel(e.laufAb),
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await requireAdminTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  if (auth.isImpersonating) return NextResponse.json({ success: false, error: "Nicht in «Ansicht als»." }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { vertretung_profile_id?: unknown } | null;
  const neu = body?.vertretung_profile_id ?? null;
  if (neu !== null && (typeof neu !== "string" || !isUuid(neu))) {
    return NextResponse.json({ success: false, error: "vertretung_profile_id ungültig" }, { status: 400 });
  }

  const admin = createAdminClient();
  let name: string | null = null;
  if (neu) {
    const { data: p, error } = await admin.from("profiles").select("full_name, role, is_active").eq("id", neu).maybeSingle();
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    if (!p || p.is_active !== true || !istIntern(p.role as string)) {
      return NextResponse.json({ success: false, error: "Vertretung muss eine aktive EVENTLINE-Person sein." }, { status: 400 });
    }
    name = (p.full_name as string | null) ?? null;
  }
  // Vier Augen (Migration 359): Vertretung aendern nur per Antrag, den der
  // andere Admin bestaetigt; der DB-Trigger erzwingt dasselbe.
  let antrag: { id: string; gueltig_bis: string };
  try {
    antrag = await stelleRechteAntrag(admin, {
      art: "vertretung",
      zielProfileId: neu,
      zielName: name,
      payload: { vertretung_profile_id: neu, vertretung_name: name },
      beschreibung: neu ? `Vertretung: ${name ?? neu}` : "Vertretung entfernen",
      gewaehrt: !!neu,
      actorId: auth.user.id,
      actorName: await ladeName(admin, auth.user.id),
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
  return NextResponse.json({ success: true, antrag, hinweis: ANTRAG_HINWEIS });
}
