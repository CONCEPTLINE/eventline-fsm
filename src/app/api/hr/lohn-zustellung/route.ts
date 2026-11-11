// Zustellung der Lohndokumente: Wahl digital/Papier der Person selbst
// (Lohn-Umbau Phase 4, Logik src/lib/lohn/zustellung.ts). Die Wahl gibt das ERP
// Trust flow bei jeder abgelegten Abrechnung zurück (/api/flow/lohnabrechnung).
//
// GET                       eigene Wahl («Meine»; nie in «Ansicht als»)
//                           → { wahl: {wahl, version, gewaehlt_at, quelle} | null, version_aktuell }
// POST { wahl }             die Person selbst: «digital» (= Einwilligung, wie
//                           accept-digital) oder «papier» (Einwilligung widerrufen)

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { DIGITAL_EINWILLIGUNG_VERSION, ladeAktuelleWahl, speichereWahl, type ZustellWahl } from "@/lib/lohn/zustellung";

const fehler = (e: unknown, status = 500) =>
  NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status });

export async function GET() {
  const admin = createAdminClient();
  const auth = await requireUser({ wartung: "lohn" });
  if (auth.error) return auth.error;
  if (auth.isImpersonating) return NextResponse.json({ success: true, ansicht_als: true, wahl: null, version_aktuell: DIGITAL_EINWILLIGUNG_VERSION });
  try {
    const w = await ladeAktuelleWahl(admin, auth.user.id);
    return NextResponse.json(
      { success: true, wahl: w ? { wahl: w.wahl, version: w.version, gewaehlt_at: w.gewaehlt_at, quelle: w.quelle } : null, version_aktuell: DIGITAL_EINWILLIGUNG_VERSION },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fehler(e);
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { wahl?: unknown } | null;
  const wahl = body?.wahl;
  if (wahl !== "digital" && wahl !== "papier") return NextResponse.json({ success: false, error: "Wahl ungültig (digital oder papier)" }, { status: 400 });
  const admin = createAdminClient();

  // Die Person selbst (echtes Konto, nie «Ansicht als»).
  const basis = await requireUser({ wartung: "lohn" });
  if (basis.error) return basis.error;
  if (basis.isImpersonating) {
    return NextResponse.json({ success: false, error: "Die Wahl trifft nur die Person selbst — nicht in «Ansicht als»." }, { status: 403 });
  }
  try {
    const { data: me } = await admin.from("profiles").select("full_name").eq("id", basis.user.id).maybeSingle();
    await speichereWahl(admin, { profileId: basis.user.id, wahl: wahl as ZustellWahl, quelle: "selbst", akteurId: basis.user.id, akteurName: (me?.full_name as string | null) ?? null });
    return NextResponse.json({ success: true });
  } catch (e) {
    return fehler(e);
  }
}
