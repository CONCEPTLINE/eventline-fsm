// HR-Compensation-API.
//
// GET  /api/hr/compensation       — alle Mitarbeiter + ihre AKTUELLE Lohn-Zeile
//                                   (effective_to IS NULL). Permission: lohn:manage.
// POST /api/hr/compensation       — Lohn-Zeile setzen. Body:
//                                   { profile_id, hourly_wage_chf,
//                                     employer_costs_chf_per_hour, effective_from?, notes? }
//                                   Schliesst die alte aktuelle Zeile (setzt
//                                   effective_to = effective_from - 1 day) und
//                                   legt eine neue an. So bleibt die Historie
//                                   sauber erhalten.
// Permission: lohn:manage (Admin laeuft via has_permission durch).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireTrustedDevice } from "@/lib/api-auth";

export async function GET() {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const admin = createAdminClient();

  // Aktive Profiles (alle ausser Partner — Partner haben kein Lohnverhaeltnis bei uns).
  const { data: profiles, error: profErr } = await admin
    .from("profiles")
    .select("id, full_name, role, email")
    .neq("role", "partner")
    .order("full_name");
  if (profErr) return NextResponse.json({ success: false, error: profErr.message }, { status: 500 });

  // Aktuelle Compensation-Zeile pro User (effective_to IS NULL).
  const { data: comps, error: compErr } = await admin
    .from("employee_compensation")
    .select("id, profile_id, hourly_wage_chf, employer_costs_chf_per_hour, effective_from, notes, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct")
    .is("effective_to", null);
  if (compErr) return NextResponse.json({ success: false, error: compErr.message }, { status: 500 });

  const byProfile = new Map<string, typeof comps[number]>();
  for (const c of comps ?? []) byProfile.set(c.profile_id as string, c);

  const rows = (profiles ?? []).map((p) => {
    const c = byProfile.get(p.id as string);
    return {
      profile_id: p.id,
      full_name: p.full_name,
      role: p.role,
      email: p.email,
      compensation: c
        ? {
            id: c.id,
            hourly_wage_chf: Number(c.hourly_wage_chf),
            employer_costs_chf_per_hour: Number(c.employer_costs_chf_per_hour),
            effective_from: c.effective_from,
            notes: c.notes,
            ahv_iv_eo_pct: Number(c.ahv_iv_eo_pct ?? 5.3),
            alv_pct: Number(c.alv_pct ?? 1.1),
            nbu_pct: Number(c.nbu_pct ?? 1.4),
            bvg_pct: Number(c.bvg_pct ?? 0),
            ktg_pct: Number(c.ktg_pct ?? 0),
            quellensteuer_pct: Number(c.quellensteuer_pct ?? 0),
          }
        : null,
    };
  });

  return NextResponse.json({ success: true, employees: rows });
}

export async function POST(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungueltiger Body" }, { status: 400 });

  // Coerce zuerst → Number, dann isFinite-Check. Body kann sowohl Number
  // als auch String-formatierte Zahl liefern (JSON Type kann beides).
  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const profile_id = typeof body.profile_id === "string" ? body.profile_id : null;
  const hourly_wage_chf = toNum(body.hourly_wage_chf);
  const employer_costs_chf_per_hour = toNum(body.employer_costs_chf_per_hour) ?? 0;
  const effective_from = typeof body.effective_from === "string" ? body.effective_from : new Date().toISOString().slice(0, 10);
  const notes = typeof body.notes === "string" ? body.notes.trim() : null;

  // Abzuege (% vom Brutto). Wenn Feld fehlt → Default. Wenn Feld da aber
  // out-of-range → 400 statt silent fallback (sonst speichert man invalid
  // Werte ohne Feedback).
  let validationError: string | null = null;
  function pct(key: string, fallback: number): number {
    const v = body[key];
    if (v == null) return fallback;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      validationError ??= `${key} ungültig (erwartet 0-100, war ${v})`;
      return fallback;
    }
    return n;
  }
  const ahv_iv_eo_pct = pct("ahv_iv_eo_pct", 5.3);
  const alv_pct = pct("alv_pct", 1.1);
  const nbu_pct = pct("nbu_pct", 1.4);
  const bvg_pct = pct("bvg_pct", 0);
  const ktg_pct = pct("ktg_pct", 0);
  const quellensteuer_pct = pct("quellensteuer_pct", 0);
  if (validationError) return NextResponse.json({ success: false, error: validationError }, { status: 400 });
  // Sanity-Check: Summe der Abzuege darf nicht >= 100% sein (Netto waere negativ).
  const totalDeductionPct = ahv_iv_eo_pct + alv_pct + nbu_pct + bvg_pct + ktg_pct + quellensteuer_pct;
  if (totalDeductionPct >= 100) {
    return NextResponse.json({
      success: false,
      error: `Summe der Abzuege ist ${totalDeductionPct.toFixed(2)}% — muss < 100% sein (Netto waere negativ).`,
    }, { status: 400 });
  }

  if (!profile_id) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  if (hourly_wage_chf === null || hourly_wage_chf < 0) {
    return NextResponse.json({ success: false, error: "hourly_wage_chf ungueltig" }, { status: 400 });
  }
  if (hourly_wage_chf > 9999.99) {
    return NextResponse.json({ success: false, error: "Stundenlohn unrealistisch (> 9999 CHF/h)" }, { status: 400 });
  }
  if (employer_costs_chf_per_hour < 0 || employer_costs_chf_per_hour > 9999.99) {
    return NextResponse.json({ success: false, error: "Arbeitgeber-Anteil ungueltig" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Aktuelle Zeile (falls vorhanden) schliessen.
  const { data: current } = await admin
    .from("employee_compensation")
    .select("id, effective_from")
    .eq("profile_id", profile_id)
    .is("effective_to", null)
    .maybeSingle();

  if (current) {
    // Wenn das neue effective_from gleich dem alten ist: alten Datensatz
    // updaten statt einen Tag-Vorgaenger zu schliessen (waere komisch).
    if (current.effective_from === effective_from) {
      const { error } = await admin
        .from("employee_compensation")
        .update({
          hourly_wage_chf,
          employer_costs_chf_per_hour,
          notes,
          ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct,
          created_by: auth.user.id,
        })
        .eq("id", current.id);
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, mode: "updated" });
    }

    // Sonst: alte Zeile schliessen (effective_to = effective_from minus 1 Tag).
    const closeDate = new Date(effective_from);
    closeDate.setUTCDate(closeDate.getUTCDate() - 1);
    const closeIso = closeDate.toISOString().slice(0, 10);

    const { error: closeErr } = await admin
      .from("employee_compensation")
      .update({ effective_to: closeIso })
      .eq("id", current.id);
    if (closeErr) return NextResponse.json({ success: false, error: closeErr.message }, { status: 500 });
  }

  const { error: insErr } = await admin.from("employee_compensation").insert({
    profile_id,
    hourly_wage_chf,
    employer_costs_chf_per_hour,
    effective_from,
    notes,
    ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct,
    created_by: auth.user.id,
  });
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 });

  return NextResponse.json({ success: true, mode: current ? "rolled-over" : "created" });
}
