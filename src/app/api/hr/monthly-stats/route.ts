// GET /api/hr/monthly-stats?month=YYYY-MM
//
// Liefert pro Mitarbeiter die aggregierten Stunden + Kosten fuer
// den angegebenen Monat. Quelle: RPC get_monthly_payroll_stats(date).
// Permission: lohn:manage + Trusted-Device.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface RpcRow {
  profile_id: string;
  full_name: string;
  role: string;
  stempel_minutes: number;
  geplant_minutes: number;
  rapport_minutes: number;
  hourly_wage_chf: number | null;
  employer_costs_chf_per_hour: number | null;
  ahv_iv_eo_pct: number | null;
  alv_pct: number | null;
  nbu_pct: number | null;
  bvg_pct: number | null;
  ktg_pct: number | null;
  quellensteuer_pct: number | null;
}

export async function GET(req: Request) {
  // Lohnabrechnung ist strikt admin-only — Trust-Device + role='admin'.
  // Trust-Gate kommt zuerst (kann auch fuer kuenftige delegierte Rechte
  // genutzt werden), Admin-Check als zweite explizite Schranke.
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;
  const adminClient = createAdminClient();
  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ success: false, error: "Nur für Administratoren" }, { status: 403 });
  }

  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ success: false, error: "Ungültiger Monat (erwartet YYYY-MM)" }, { status: 400 });
  }
  const monthStart = `${month}-01`;

  // Caller-Client (nicht admin-bypass) — RPC nutzt is_admin() via auth.uid().
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_monthly_payroll_stats", { p_month_start: monthStart });
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  // Lohnkosten berechnen — Konvention: rapport-Stunden × Lohn. Wenn keine
  // Rapport-Daten, fallback auf Stempel-Stunden (Mitarbeiter hat zwar
  // gestempelt aber noch keinen Rapport unterschrieben).
  // Netto = Brutto-Lohnkosten × (1 - Summe-Abzuege/100).
  const employees = (data as RpcRow[]).map((r) => {
    const effectiveMinutes = r.rapport_minutes > 0 ? r.rapport_minutes : r.stempel_minutes;
    const hours = effectiveMinutes / 60;
    const wage = r.hourly_wage_chf != null ? Number(r.hourly_wage_chf) : null;
    const employer = r.employer_costs_chf_per_hour != null ? Number(r.employer_costs_chf_per_hour) : 0;
    const lohnkosten = wage != null ? hours * wage : null;
    const vollkosten = wage != null ? hours * (wage + employer) : null;
    const totalDeductionPct = Number(r.ahv_iv_eo_pct ?? 0)
      + Number(r.alv_pct ?? 0)
      + Number(r.nbu_pct ?? 0)
      + Number(r.bvg_pct ?? 0)
      + Number(r.ktg_pct ?? 0)
      + Number(r.quellensteuer_pct ?? 0);
    const nettolohn = lohnkosten != null ? lohnkosten * (1 - totalDeductionPct / 100) : null;
    return {
      ...r,
      hourly_wage_chf: wage,
      employer_costs_chf_per_hour: r.employer_costs_chf_per_hour != null ? Number(r.employer_costs_chf_per_hour) : null,
      effective_basis: r.rapport_minutes > 0 ? "rapport" : "stempel",
      lohnkosten_chf: lohnkosten,
      vollkosten_chf: vollkosten,
      nettolohn_chf: nettolohn,
      total_deduction_pct: totalDeductionPct,
    };
  });

  return NextResponse.json({ success: true, month, employees });
}
