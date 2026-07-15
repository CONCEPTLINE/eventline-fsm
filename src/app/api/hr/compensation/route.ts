// HR-Compensation-API.
//
// GET  /api/hr/compensation       — alle Mitarbeiter + ihre AKTUELLE Lohn-Zeile
//                                   (effective_to IS NULL). Permission: lohn:manage.
// POST /api/hr/compensation       — Lohn-Zeile setzen. Body:
//                                   { profile_id, hourly_wage_chf,
//                                     uses_standard_lohn,
//                                     ahv_iv_eo_pct, alv_pct, nbu_pct,
//                                     bvg_pct, ktg_pct, quellensteuer_pct,
//                                     employer_ahv_pct, employer_alv_pct,
//                                     employer_fak_pct, employer_bu_pct,
//                                     employer_bvg_pct, employer_verwaltung_pct,
//                                     effective_from?, notes? }
//                                   Schliesst die alte aktuelle Zeile (setzt
//                                   effective_to = effective_from - 1 day) und
//                                   legt eine neue an.
// Permission: lohn:manage.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireTrustedDevice } from "@/lib/api-auth";
import { loadLohnDefaults, sumEmployeePct, effectivePcts } from "@/lib/employer-costs";
import { localDateIso, todayLocalIso } from "@/lib/swiss-time";

const PCT_COLUMNS = [
  "ahv_iv_eo_pct", "alv_pct", "nbu_pct", "bvg_pct", "ktg_pct", "quellensteuer_pct",
  "employer_ahv_pct", "employer_alv_pct", "employer_fak_pct", "employer_bu_pct", "employer_bvg_pct", "employer_verwaltung_pct",
] as const;

function toNullableNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET() {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const admin = createAdminClient();

  const [profilesRes, compsRes, defaults] = await Promise.all([
    admin.from("profiles").select("id, full_name, role, email, birthdate").neq("role", "partner").order("full_name"),
    admin.from("employee_compensation")
      .select("id, profile_id, hourly_wage_chf, uses_standard_lohn, wage_exempt, effective_from, notes, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, ferienanteil_pct_override")
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
      // Birthdate fuer Ferienanteil-Auto-Erkennung (U20 -> 10.64%, sonst 8.33%).
      birthdate: (p as { birthdate?: string | null }).birthdate ?? null,
      compensation: c
        ? {
            id: c.id,
            hourly_wage_chf: Number(c.hourly_wage_chf),
            uses_standard_lohn: c.uses_standard_lohn !== false,
            wage_exempt: (c as { wage_exempt?: boolean }).wage_exempt === true,
            effective_from: c.effective_from,
            notes: c.notes,
            ahv_iv_eo_pct: toNullableNumber(c.ahv_iv_eo_pct),
            alv_pct: toNullableNumber(c.alv_pct),
            nbu_pct: toNullableNumber(c.nbu_pct),
            bvg_pct: toNullableNumber(c.bvg_pct),
            ktg_pct: toNullableNumber(c.ktg_pct),
            quellensteuer_pct: toNullableNumber(c.quellensteuer_pct),
            employer_ahv_pct: toNullableNumber(c.employer_ahv_pct),
            employer_alv_pct: toNullableNumber(c.employer_alv_pct),
            employer_fak_pct: toNullableNumber(c.employer_fak_pct),
            employer_bu_pct: toNullableNumber(c.employer_bu_pct),
            employer_bvg_pct: toNullableNumber(c.employer_bvg_pct),
            employer_verwaltung_pct: toNullableNumber(c.employer_verwaltung_pct),
            ferienanteil_pct_override: toNullableNumber(c.ferienanteil_pct_override),
          }
        : null,
    };
  });

  return NextResponse.json({ success: true, employees: rows, defaults });
}

export async function POST(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungueltiger Body" }, { status: 400 });

  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const profile_id = typeof body.profile_id === "string" ? body.profile_id : null;
  const wage_exempt = body.wage_exempt === true;
  // Bei wage_exempt=true wird kein Lohn ausbezahlt — hourly_wage_chf auf 0
  // gesetzt (Spalte ist NOT NULL). Frontend darf hourly_wage_chf trotzdem
  // schicken, wir ignorieren es aber.
  const hourly_wage_chf = wage_exempt ? 0 : toNum(body.hourly_wage_chf);
  // Default: uses_standard_lohn = true (= alle Pcts werden ignoriert).
  // Frontend muss explizit false setzen wenn Overrides gewollt sind.
  const uses_standard_lohn = body.uses_standard_lohn !== false;
  const effective_from = typeof body.effective_from === "string" ? body.effective_from : todayLocalIso();
  const notes = typeof body.notes === "string" ? body.notes.trim() : null;
  // Ferienanteil-Override: null = aus Geburtsdatum berechnen (8.33/10.64),
  // Zahl = expliziter Override.
  const ferienanteil_pct_override: number | null = toNum(body.ferienanteil_pct_override);
  if (ferienanteil_pct_override != null && (ferienanteil_pct_override < 0 || ferienanteil_pct_override > 100)) {
    return NextResponse.json({ success: false, error: "Ferienanteil ungueltig" }, { status: 400 });
  }

  if (!profile_id) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  // Wenn nicht exempt: Lohn muss gueltig sein. Wenn exempt: hourly_wage_chf
  // ist forciert auf 0 und wir ueberspringen die Range-Checks.
  if (!wage_exempt) {
    if (hourly_wage_chf === null || hourly_wage_chf < 0) {
      return NextResponse.json({ success: false, error: "hourly_wage_chf ungueltig" }, { status: 400 });
    }
    if (hourly_wage_chf > 9999.99) {
      return NextResponse.json({ success: false, error: "Stundenlohn unrealistisch (> 9999 CHF/h)" }, { status: 400 });
    }
  }

  // Pct-Spalten validieren: each 0..100 oder null. Bei uses_standard_lohn=true
  // werden sie eh ignoriert, also auch dann valid wenn null.
  const pctValues: Record<string, number | null> = {};
  let pctError: string | null = null;
  for (const col of PCT_COLUMNS) {
    const v = toNum((body as Record<string, unknown>)[col]);
    if (v != null && (v < 0 || v > 100)) {
      pctError = `${col} ungueltig (erwartet 0-100)`;
      break;
    }
    pctValues[col] = v;
  }
  if (pctError) return NextResponse.json({ success: false, error: pctError }, { status: 400 });

  // Sanity-Check: Summe der AN-Abzuege < 100% (egal ob Override oder
  // Standard — wir validieren immer gegen die *effektiven* Werte).
  // Bei wage_exempt=true skipppen wir das (kein Lohn -> keine Abzuege).
  if (!wage_exempt) {
    const defaults = await loadLohnDefaults(createAdminClient());
    const effective = effectivePcts(
      uses_standard_lohn
        ? { uses_standard_lohn: true }
        : {
            uses_standard_lohn: false,
            ahv_iv_eo_pct: pctValues.ahv_iv_eo_pct,
            alv_pct: pctValues.alv_pct,
            nbu_pct: pctValues.nbu_pct,
            bvg_pct: pctValues.bvg_pct,
            ktg_pct: pctValues.ktg_pct,
            quellensteuer_pct: pctValues.quellensteuer_pct,
          },
      defaults,
    );
    if (sumEmployeePct(effective) >= 100) {
      return NextResponse.json({
        success: false,
        error: `Summe der Mitarbeiter-Abzuege ist ${sumEmployeePct(effective).toFixed(2)}% — muss < 100% sein.`,
      }, { status: 400 });
    }
  }

  const admin = createAdminClient();

  // Aktuelle Zeile (falls vorhanden) schliessen.
  const { data: current } = await admin
    .from("employee_compensation")
    .select("id, effective_from")
    .eq("profile_id", profile_id)
    .is("effective_to", null)
    .maybeSingle();

  // Wenn uses_standard_lohn=true: alle Pct-Spalten auf null setzen
  // (saubere Trennung; sonst koennten alte Override-Werte hinter dem
  // Flag noch rumliegen und bei spaeterem Toggle wieder aufploppen).
  const pctPayload = uses_standard_lohn
    ? Object.fromEntries(PCT_COLUMNS.map((c) => [c, null]))
    : pctValues;

  if (current) {
    if (current.effective_from === effective_from) {
      const { error } = await admin
        .from("employee_compensation")
        .update({
          hourly_wage_chf,
          uses_standard_lohn,
          wage_exempt,
          notes,
          ferienanteil_pct_override,
          ...pctPayload,
          created_by: auth.user.id,
        })
        .eq("id", current.id);
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, mode: "updated" });
    }

    // effective_from ist YYYY-MM-DD (ZRH-Datum). closeIso = Vortag,
    // ebenfalls ZRH-Kalender. Direkt String-Arithmetik damit kein
    // UTC-Detour entsteht.
    const [cy, cm, cd] = effective_from.split("-").map(Number);
    const prev = new Date(Date.UTC(cy, cm - 1, cd - 1, 12));
    const closeIso = localDateIso(prev);

    const { error: closeErr } = await admin
      .from("employee_compensation")
      .update({ effective_to: closeIso })
      .eq("id", current.id);
    if (closeErr) return NextResponse.json({ success: false, error: closeErr.message }, { status: 500 });
  }

  const { error: insErr } = await admin.from("employee_compensation").insert({
    profile_id,
    hourly_wage_chf,
    uses_standard_lohn,
    wage_exempt,
    effective_from,
    notes,
    ferienanteil_pct_override,
    ...pctPayload,
    created_by: auth.user.id,
  });
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 });

  return NextResponse.json({ success: true, mode: current ? "rolled-over" : "created" });
}
