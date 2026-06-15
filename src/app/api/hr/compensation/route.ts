// HR-Compensation-API.
//
// GET  /api/hr/compensation       — alle Mitarbeiter + ihre AKTUELLE Lohn-Zeile
//                                   (effective_to IS NULL). Permission: lohn:manage.
// POST /api/hr/compensation       — Lohn-Zeile setzen. Body:
//                                   { profile_id, hourly_wage_chf,
//                                     employer_pct, effective_from?, notes? }
//                                   Schliesst die alte aktuelle Zeile (setzt
//                                   effective_to = effective_from - 1 day) und
//                                   legt eine neue an. So bleibt die Historie
//                                   sauber erhalten.
// Permission: lohn:manage (Admin laeuft via has_permission durch).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireTrustedDevice } from "@/lib/api-auth";
import { loadLohnDefaults } from "@/lib/employer-costs";

// Konvertiert Spalten-Wert (string|number|null) zu number|null.
// null bleibt null (= Standard verwenden), sonst Number-Cast.
function toNullableNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET() {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const admin = createAdminClient();

  // Aktive Profiles (alle ausser Partner — Partner haben kein Lohnverhaeltnis bei uns).
  const [profilesRes, compsRes, defaults] = await Promise.all([
    admin.from("profiles").select("id, full_name, role, email").neq("role", "partner").order("full_name"),
    admin.from("employee_compensation")
      .select("id, profile_id, hourly_wage_chf, employer_pct, effective_from, notes, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct")
      .is("effective_to", null),
    loadLohnDefaults(admin),
  ]);
  if (profilesRes.error) return NextResponse.json({ success: false, error: profilesRes.error.message }, { status: 500 });
  if (compsRes.error) return NextResponse.json({ success: false, error: compsRes.error.message }, { status: 500 });

  const byProfile = new Map<string, typeof compsRes.data[number]>();
  for (const c of compsRes.data ?? []) byProfile.set(c.profile_id as string, c);

  const rows = (profilesRes.data ?? []).map((p) => {
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
            // null = nutzt Standard, ansonsten der explizite Override-Wert.
            // Frontend entscheidet anhand von null vs. Number ob die Checkbox
            // 'Standard verwenden' an oder aus ist.
            employer_pct: toNullableNumber(c.employer_pct),
            effective_from: c.effective_from,
            notes: c.notes,
            ahv_iv_eo_pct: toNullableNumber(c.ahv_iv_eo_pct),
            alv_pct: toNullableNumber(c.alv_pct),
            nbu_pct: toNullableNumber(c.nbu_pct),
            bvg_pct: toNullableNumber(c.bvg_pct),
            ktg_pct: toNullableNumber(c.ktg_pct),
            quellensteuer_pct: toNullableNumber(c.quellensteuer_pct),
          }
        : null,
    };
  });

  return NextResponse.json({
    success: true,
    employees: rows,
    defaults: {
      employer_pct: defaults.employerPct,
      ahv_iv_eo_pct: defaults.ahvIvEoPct,
      alv_pct: defaults.alvPct,
      nbu_pct: defaults.nbuPct,
      bvg_pct: defaults.bvgPct,
      ktg_pct: defaults.ktgPct,
      quellensteuer_pct: defaults.quellensteuerPct,
    },
  });
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
  // Override-Logik: NULL bedeutet 'Standard verwenden'. Frontend sendet
  // explizit null wenn die 'Standard'-Checkbox an ist. toNum() konvertiert
  // null/undefined zu null (was wir wollen), Strings/Numbers zu Number.
  // employer_pct = % vom Brutto (Migration 154, ersetzt das alte CHF-Feld).
  const employer_pct: number | null = toNum(body.employer_pct);
  const effective_from = typeof body.effective_from === "string" ? body.effective_from : new Date().toISOString().slice(0, 10);
  const notes = typeof body.notes === "string" ? body.notes.trim() : null;

  // Abzuege (% vom Brutto). null = nutze Standard, number = expliziter
  // Override. Out-of-range -> 400 statt silent fallback.
  let validationError: string | null = null;
  function pctNullable(key: string): number | null {
    const v = body[key];
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      validationError ??= `${key} ungültig (erwartet 0-100, war ${v})`;
      return null;
    }
    return n;
  }
  const ahv_iv_eo_pct = pctNullable("ahv_iv_eo_pct");
  const alv_pct = pctNullable("alv_pct");
  const nbu_pct = pctNullable("nbu_pct");
  const bvg_pct = pctNullable("bvg_pct");
  const ktg_pct = pctNullable("ktg_pct");
  const quellensteuer_pct = pctNullable("quellensteuer_pct");
  if (validationError) return NextResponse.json({ success: false, error: validationError }, { status: 400 });
  // Sanity-Check: Summe darf nicht >= 100% sein. Fuer NULL-Werte
  // ziehen wir die Defaults aus app_settings damit der Check sinnvoll
  // bleibt (sonst koennte jemand alle als Standard markieren und der
  // gespeicherte Standard die Summe ueberschreiten lassen).
  const defaults = await loadLohnDefaults(createAdminClient());
  const totalDeductionPct =
      (ahv_iv_eo_pct ?? defaults.ahvIvEoPct)
    + (alv_pct ?? defaults.alvPct)
    + (nbu_pct ?? defaults.nbuPct)
    + (bvg_pct ?? defaults.bvgPct)
    + (ktg_pct ?? defaults.ktgPct)
    + (quellensteuer_pct ?? defaults.quellensteuerPct);
  if (totalDeductionPct >= 100) {
    return NextResponse.json({
      success: false,
      error: `Summe der Abzuege (inkl. Standards) ist ${totalDeductionPct.toFixed(2)}% — muss < 100% sein.`,
    }, { status: 400 });
  }

  if (!profile_id) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  if (hourly_wage_chf === null || hourly_wage_chf < 0) {
    return NextResponse.json({ success: false, error: "hourly_wage_chf ungueltig" }, { status: 400 });
  }
  if (hourly_wage_chf > 9999.99) {
    return NextResponse.json({ success: false, error: "Stundenlohn unrealistisch (> 9999 CHF/h)" }, { status: 400 });
  }
  if (employer_pct != null && (employer_pct < 0 || employer_pct > 100)) {
    return NextResponse.json({ success: false, error: "Arbeitgeber-Anteil % ungueltig (erwartet 0-100)" }, { status: 400 });
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
          employer_pct,
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
    employer_pct,
    effective_from,
    notes,
    ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct,
    created_by: auth.user.id,
  });
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 });

  return NextResponse.json({ success: true, mode: current ? "rolled-over" : "created" });
}
