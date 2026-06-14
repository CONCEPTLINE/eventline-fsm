// Lohn-Standardwerte (firmenweit). Aktuell nur default_employer_costs_chf_per_hour,
// kann spaeter um Default-Abzuege etc. wachsen.
//
// GET  -> { defaultEmployerCostsChfPerHour: number }
// POST -> { default_employer_costs_chf_per_hour }
//
// Permission: lohn:manage (Admin laeuft via has_permission automatisch durch).
// requireTrustedDevice damit das Setzen nicht von beliebigen Geraeten
// passieren kann (sensible Daten).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireTrustedDevice } from "@/lib/api-auth";

export async function GET() {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data } = await admin
    .from("app_settings")
    .select("default_employer_costs_chf_per_hour")
    .eq("id", 1)
    .maybeSingle();
  return NextResponse.json({
    success: true,
    defaultEmployerCostsChfPerHour: Number(data?.default_employer_costs_chf_per_hour ?? 0),
  });
}

export async function POST(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungueltiger Body" }, { status: 400 });

  const raw = body.default_employer_costs_chf_per_hour;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 9999.99) {
    return NextResponse.json({ success: false, error: "Wert ungueltig (0..9999.99)" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("app_settings")
    .update({ default_employer_costs_chf_per_hour: value })
    .eq("id", 1);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
