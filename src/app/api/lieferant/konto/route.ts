// GET /api/lieferant/konto — Kontodaten des Lieferanten-Portal-Users fuer
// «Mein Konto». Admin-Client mit Whitelist: das Portal liest so weder
// lieferanten noch fremde profiles im Browser.
// «Ansicht als»-faehig: requireLieferantPortal arbeitet mit effectiveUserId,
// ein Admin im View-As bekommt also die Daten der angesehenen Person — nicht
// seine eigenen. Der Firmenname kommt aus demselben Gate (aktive Firma).

import { NextResponse } from "next/server";
import { requireLieferantPortal } from "@/lib/technik-server";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, userId, lieferantName } = gate;

  const { data, error } = await admin
    .from("profiles")
    .select("full_name, email, datenschutz_akzeptiert_at, datenschutz_akzeptiert_version")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) {
    logError("api.lieferant.konto", error ?? "Profil fehlt", { userId });
    return NextResponse.json({ success: false, error: "Konto konnte nicht geladen werden" }, { status: 500 });
  }

  return NextResponse.json(
    {
      success: true,
      konto: {
        full_name: data.full_name as string,
        email: data.email as string,
        firma_name: lieferantName,
        datenschutz_akzeptiert_at: (data.datenschutz_akzeptiert_at as string | null) ?? null,
        datenschutz_akzeptiert_version: (data.datenschutz_akzeptiert_version as string | null) ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
