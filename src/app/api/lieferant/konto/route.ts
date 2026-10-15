// GET /api/lieferant/konto — Kontodaten des Lieferanten-Portal-Users fuer
// «Mein Konto» und den Portal-Kopf (Firmenname). Admin-Client mit Whitelist:
// das Portal liest so weder lieferanten noch fremde profiles im Browser.
// «Ansicht als»-faehig: requireLieferantPortal arbeitet mit effectiveUserId,
// ein Admin im View-As bekommt also die Daten der angesehenen Person — nicht
// seine eigenen.

import { NextResponse } from "next/server";
import { requireLieferantPortal } from "@/lib/technik-server";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, userId, lieferantId } = gate;

  const [profilRes, firmaRes] = await Promise.all([
    admin
      .from("profiles")
      .select("full_name, email, datenschutz_akzeptiert_at, datenschutz_akzeptiert_version")
      .eq("id", userId)
      .maybeSingle(),
    admin.from("lieferanten").select("name").eq("id", lieferantId).maybeSingle(),
  ]);
  if (profilRes.error || firmaRes.error || !profilRes.data) {
    logError("api.lieferant.konto", profilRes.error ?? firmaRes.error ?? "Profil fehlt", { userId });
    return NextResponse.json({ success: false, error: "Konto konnte nicht geladen werden" }, { status: 500 });
  }

  return NextResponse.json(
    {
      success: true,
      konto: {
        full_name: profilRes.data.full_name as string,
        email: profilRes.data.email as string,
        firma_name: (firmaRes.data?.name as string | undefined) ?? null,
        datenschutz_akzeptiert_at: (profilRes.data.datenschutz_akzeptiert_at as string | null) ?? null,
        datenschutz_akzeptiert_version: (profilRes.data.datenschutz_akzeptiert_version as string | null) ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
