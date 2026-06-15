// Lohn-Standardwerte (firmenweit). Firmenweite Defaults fuer
// Arbeitgeber-Kosten und alle Mitarbeiter-Abzuege. Pro Mitarbeiter
// koennen einzelne Werte ueberschrieben werden (siehe employee_compensation
// — NULL = nutze Standard).
//
// GET  -> { defaults: { employerCostsChfPerHour, ahvIvEoPct, alvPct, nbuPct, bvgPct, ktgPct, quellensteuerPct } }
// POST -> Body kann einzelne oder alle Felder enthalten — partial update.
//
// Permission: lohn:manage (Admin laeuft via has_permission automatisch durch).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireTrustedDevice } from "@/lib/api-auth";
import { loadLohnDefaults } from "@/lib/employer-costs";

export async function GET() {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const defaults = await loadLohnDefaults(createAdminClient());
  return NextResponse.json({ success: true, defaults });
}

// Alle 7 Defaults sind ab Migration 154 Prozentwerte. AG-Anteil =
// Prozent vom Brutto (Migration 154), restliche 6 = Mitarbeiter-Abzuege.
const FIELDS: Array<{ key: string; column: string }> = [
  { key: "default_employer_pct", column: "default_employer_pct" },
  { key: "default_ahv_iv_eo_pct", column: "default_ahv_iv_eo_pct" },
  { key: "default_alv_pct", column: "default_alv_pct" },
  { key: "default_nbu_pct", column: "default_nbu_pct" },
  { key: "default_bvg_pct", column: "default_bvg_pct" },
  { key: "default_ktg_pct", column: "default_ktg_pct" },
  { key: "default_quellensteuer_pct", column: "default_quellensteuer_pct" },
];

export async function POST(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false, error: "Ungueltiger Body" }, { status: 400 });
  }

  const update: Record<string, number> = {};
  for (const f of FIELDS) {
    if (!(f.key in body)) continue;
    const raw = (body as Record<string, unknown>)[f.key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return NextResponse.json({ success: false, error: `${f.key} ungueltig (erwartet 0-100)` }, { status: 400 });
    }
    update[f.column] = value;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: false, error: "Keine Felder zum Updaten" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("app_settings").update(update).eq("id", 1);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
