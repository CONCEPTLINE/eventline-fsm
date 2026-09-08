// HR-Compensation-API.
//
// GET  /api/hr/compensation       — alle Mitarbeiter + ihre HEUTE gueltige
//                                   Lohn-Zeile (datumsbasiert, NICHT einfach
//                                   effective_to IS NULL — sonst wuerde eine
//                                   geplante Zukunfts-Erhoehung sofort als
//                                   "aktueller Lohn" angezeigt) + die naechste
//                                   geplante Zeile (next_compensation).
// POST /api/hr/compensation       — Lohn-Zeile setzen. Body:
//                                   { profile_id, hourly_wage_chf,
//                                     uses_standard_lohn, ..., effective_from?, notes? }
//                                   Regeln:
//                                   - effective_from == bestehende Zeile → UPDATE (Korrektur).
//                                   - Zukunfts-Zeile existiert + anderes Datum → Fehler
//                                     (nur EINE geplante Erhoehung gleichzeitig; erst loeschen).
//                                   - sonst Roll-over: offene Zeile schliessen
//                                     (effective_to = Vortag), neue anlegen.
// DELETE /api/hr/compensation?id= — GEPLANTE Zeile (effective_from > heute)
//                                   loeschen + Vorgaenger-Zeile wieder oeffnen
//                                   (effective_to = NULL). Vergangene/aktuelle
//                                   Zeilen sind NICHT loeschbar (Historie).
// Permission: lohn:manage (+ Trusted Device).

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
  const today = todayLocalIso();

  const COMP_COLS = "id, profile_id, hourly_wage_chf, uses_standard_lohn, wage_exempt, auto_lohnabrechnung, effective_from, effective_to, notes, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, ferienanteil_pct_override";

  const [profilesRes, currentRes, futureRes, defaults] = await Promise.all([
    admin.from("profiles").select("id, full_name, role, email, birthdate").neq("role", "partner").order("full_name"),
    // HEUTE gueltige Zeile: effective_from <= heute <= (effective_to | ∞).
    admin.from("employee_compensation")
      .select(COMP_COLS)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`),
    // Naechste geplante Zeile(n) pro MA (fuer "ab X: CHF Y"-Anzeige).
    admin.from("employee_compensation")
      .select("id, profile_id, hourly_wage_chf, wage_exempt, effective_from, notes")
      .gt("effective_from", today)
      .order("effective_from", { ascending: true }),
    loadLohnDefaults(admin),
  ]);
  if (profilesRes.error) return NextResponse.json({ success: false, error: profilesRes.error.message }, { status: 500 });
  if (currentRes.error) return NextResponse.json({ success: false, error: currentRes.error.message }, { status: 500 });
  if (futureRes.error) return NextResponse.json({ success: false, error: futureRes.error.message }, { status: 500 });

  const byProfile = new Map<string, typeof currentRes.data[number]>();
  for (const c of currentRes.data ?? []) byProfile.set(c.profile_id as string, c);
  // Erste (frueheste) Zukunfts-Zeile pro Profil — Query ist asc sortiert.
  const nextByProfile = new Map<string, typeof futureRes.data[number]>();
  for (const c of futureRes.data ?? []) {
    if (!nextByProfile.has(c.profile_id as string)) nextByProfile.set(c.profile_id as string, c);
  }

  const rows = (profilesRes.data ?? []).map((p) => {
    const c = byProfile.get(p.id as string);
    const next = nextByProfile.get(p.id as string);
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
            // Default true (Migration 184 default) — bei Legacy-Rows ohne Spalte auch true.
            auto_lohnabrechnung: (c as { auto_lohnabrechnung?: boolean }).auto_lohnabrechnung !== false,
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
      next_compensation: next
        ? {
            id: next.id,
            hourly_wage_chf: Number(next.hourly_wage_chf),
            wage_exempt: (next as { wage_exempt?: boolean }).wage_exempt === true,
            effective_from: next.effective_from,
            notes: next.notes,
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
  if (!body) return NextResponse.json({ success: false, error: "Ungültiger Body" }, { status: 400 });

  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const profile_id = typeof body.profile_id === "string" ? body.profile_id : null;
  const wage_exempt = body.wage_exempt === true;
  // Auto-Lohnabrechnung (Cron 7 Tage nach Monatsende): default true;
  // Frontend darf explizit false schicken um zu deaktivieren. Bei
  // wage_exempt=true zwingt der Server auf false (kein Lohn -> keine Abrechnung).
  const auto_lohnabrechnung = wage_exempt ? false : body.auto_lohnabrechnung !== false;
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
    return NextResponse.json({ success: false, error: "Ferienanteil ungültig" }, { status: 400 });
  }

  if (!profile_id) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  // Wenn nicht exempt: Lohn muss gueltig sein. Wenn exempt: hourly_wage_chf
  // ist forciert auf 0 und wir ueberspringen die Range-Checks.
  if (!wage_exempt) {
    if (hourly_wage_chf === null || hourly_wage_chf < 0) {
      return NextResponse.json({ success: false, error: "hourly_wage_chf ungültig" }, { status: 400 });
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
      pctError = `${col} ungültig (erwartet 0-100)`;
      break;
    }
    pctValues[col] = v;
  }
  if (pctError) return NextResponse.json({ success: false, error: pctError }, { status: 400 });

  // Sanity-Check: Summe der AN-Abzuege < 100% (egal ob Override oder
  // Standard — wir validieren immer gegen die *effektiven* Werte).
  // Bei wage_exempt=true skipppen wir das (kein Lohn -> keine Abzuege).
  if (!wage_exempt) {
    // asOf=effective_from — der Sanity-Check "AN-Abzuege >= 100%" muss gegen
    // die zum Gueltigkeits-Start greifende Baseline pruefen (Migration 195).
    // Ohne asOf wuerde eine 2027-Comp-Row gegen die 2026-Defaults gepruft.
    const defaults = await loadLohnDefaults(createAdminClient(), effective_from);
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
        error: `Summe der Mitarbeiter-Abzüge ist ${sumEmployeePct(effective).toFixed(2)}% — muss < 100% sein.`,
      }, { status: 400 });
    }
  }

  const admin = createAdminClient();

  // Alle Zeilen des Profils laden — wir brauchen exact-Match-Erkennung
  // (Korrektur), Zukunfts-Zeilen (nur EINE geplante Erhoehung gleichzeitig)
  // und die offene Zeile (Roll-over-Ziel).
  const { data: allRows, error: rowsErr } = await admin
    .from("employee_compensation")
    .select("id, effective_from, effective_to")
    .eq("profile_id", profile_id)
    .order("effective_from", { ascending: false });
  if (rowsErr) return NextResponse.json({ success: false, error: rowsErr.message }, { status: 500 });

  const today = todayLocalIso();
  const rows = allRows ?? [];
  const exact = rows.find((r) => r.effective_from === effective_from) ?? null;
  const futureRows = rows.filter((r) => r.effective_from > today);
  const openRow = rows.find((r) => r.effective_to === null) ?? null;

  // Wenn uses_standard_lohn=true: alle Pct-Spalten auf null setzen
  // (saubere Trennung; sonst koennten alte Override-Werte hinter dem
  // Flag noch rumliegen und bei spaeterem Toggle wieder aufploppen).
  const pctPayload = uses_standard_lohn
    ? Object.fromEntries(PCT_COLUMNS.map((c) => [c, null]))
    : pctValues;

  // Fall 1: exakt gleiches effective_from → UPDATE dieser Zeile (Korrektur
  // am aktuellen Lohn ODER Bearbeiten einer geplanten Erhoehung).
  if (exact) {
    const { error } = await admin
      .from("employee_compensation")
      .update({
        hourly_wage_chf,
        uses_standard_lohn,
        wage_exempt,
        auto_lohnabrechnung,
        notes,
        ferienanteil_pct_override,
        ...pctPayload,
        created_by: auth.user.id,
      })
      .eq("id", exact.id);
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, mode: "updated" });
  }

  // Fall 2: es existiert bereits eine geplante Zukunfts-Zeile und das neue
  // Datum ist ein anderes → blocken. Sonst wuerde der Roll-over die
  // Zukunfts-Zeile mit einem Datum VOR ihrem effective_from schliessen
  // (Constraint-Crash) bzw. ueberlappende Fenster erzeugen. Nur EINE
  // geplante Erhoehung gleichzeitig — erst loeschen, dann neu planen.
  if (futureRows.length > 0) {
    const f = futureRows[futureRows.length - 1]; // frueheste (rows ist desc)
    return NextResponse.json({
      success: false,
      error: `Es ist bereits eine Lohnänderung ab ${f.effective_from} geplant. Lösche die geplante Änderung zuerst (Papierkorb-Symbol im Abschnitt „Lohnerhöhung planen").`,
    }, { status: 409 });
  }

  // Fall 3: Roll-over — offene Zeile schliessen (Vortag), neue anlegen.
  if (openRow) {
    // effective_from ist YYYY-MM-DD (ZRH-Datum). closeIso = Vortag,
    // ebenfalls ZRH-Kalender. Direkt String-Arithmetik damit kein
    // UTC-Detour entsteht.
    const [cy, cm, cd] = effective_from.split("-").map(Number);
    const prev = new Date(Date.UTC(cy, cm - 1, cd - 1, 12));
    const closeIso = localDateIso(prev);

    // Range-Guard: neue Zeile darf nicht VOR der offenen beginnen — sonst
    // wuerde effective_to < effective_from (Constraint emp_comp_range_valid).
    if (closeIso < openRow.effective_from) {
      return NextResponse.json({
        success: false,
        error: `Das Datum liegt vor dem Beginn der aktuellen Lohn-Zeile (${openRow.effective_from}). Für rückwirkende Korrekturen dasselbe Gültig-ab-Datum verwenden.`,
      }, { status: 400 });
    }

    const { error: closeErr } = await admin
      .from("employee_compensation")
      .update({ effective_to: closeIso })
      .eq("id", openRow.id);
    if (closeErr) return NextResponse.json({ success: false, error: closeErr.message }, { status: 500 });
  }

  const { error: insErr } = await admin.from("employee_compensation").insert({
    profile_id,
    hourly_wage_chf,
    uses_standard_lohn,
    wage_exempt,
    auto_lohnabrechnung,
    effective_from,
    notes,
    ferienanteil_pct_override,
    ...pctPayload,
    created_by: auth.user.id,
  });
  if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 });

  return NextResponse.json({ success: true, mode: openRow ? "rolled-over" : "created" });
}

// DELETE /api/hr/compensation?id=<row-id>
// Loescht eine GEPLANTE Lohn-Zeile (effective_from > heute) und oeffnet die
// Vorgaenger-Zeile wieder (effective_to = NULL) — der bisherige Lohn laeuft
// dann einfach weiter. Vergangene/aktuelle Zeilen sind bewusst NICHT
// loeschbar: das ist Lohn-Historie, die Abrechnungen referenzieren sie.
export async function DELETE(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "id fehlt" }, { status: 400 });

  const admin = createAdminClient();
  const { data: row, error: rowErr } = await admin
    .from("employee_compensation")
    .select("id, profile_id, effective_from")
    .eq("id", id)
    .maybeSingle();
  if (rowErr) return NextResponse.json({ success: false, error: rowErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ success: false, error: "Zeile nicht gefunden" }, { status: 404 });

  const today = todayLocalIso();
  if (row.effective_from <= today) {
    return NextResponse.json({
      success: false,
      error: "Nur geplante (zukünftige) Lohnänderungen können gelöscht werden — vergangene Zeilen sind Lohn-Historie.",
    }, { status: 400 });
  }

  const { error: delErr, count } = await admin
    .from("employee_compensation")
    .delete({ count: "exact" })
    .eq("id", id);
  if (delErr) return NextResponse.json({ success: false, error: delErr.message }, { status: 500 });
  if (!count) return NextResponse.json({ success: false, error: "Löschen fehlgeschlagen — Zeile nicht entfernt" }, { status: 500 });

  // Vorgaenger wieder oeffnen: die juengste verbleibende Zeile des Profils
  // bekommt effective_to = NULL (sie war beim Planen mit dem Vortag der
  // geloeschten Erhoehung geschlossen worden).
  const { data: prevRow } = await admin
    .from("employee_compensation")
    .select("id")
    .eq("profile_id", row.profile_id)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevRow) {
    const { error: reopenErr } = await admin
      .from("employee_compensation")
      .update({ effective_to: null })
      .eq("id", prevRow.id);
    if (reopenErr) return NextResponse.json({ success: false, error: "Erhöhung gelöscht, aber Vorgänger-Zeile konnte nicht wieder geöffnet werden: " + reopenErr.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
