// Firmenweite Lohn-Standardwerte mit effective_from-Historie
// (Migration 195). Multi-Row-Tabelle payroll_defaults: eine Zeile pro
// Aenderungs-Stichtag. Aktueller Stand = neueste Zeile mit
// effective_from <= today. Zukuenftige Zeilen greifen automatisch am
// jeweiligen effective_from — kein Cron noetig.
//
// GET    -> alle Zeilen (fuer UI-Aufteilung in Aktuell / Geplant / Historie)
// POST   -> neue Zeile anlegen (z.B. "gilt ab 2027-01-01")
// PATCH  -> bestehende Zeile aktualisieren (Body: {id, ...felder})
// DELETE -> Zeile loeschen (nur wenn effective_from > today — Historie ist
//           read-only; NIE alte Rechnungen bei Regenerate ihre Baseline
//           unter dem Fuss wegziehen).
//
// Permission: lohn:manage + trusted device (alle Verben).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireTrustedDevice } from "@/lib/api-auth";
import { todayLocalIso } from "@/lib/swiss-time";

// Die 12 Pct-Spalten + bvg_threshold_chf — Reihenfolge muss zur DB
// passen. Notes ist optional.
const PCT_COLUMNS = [
  "default_ahv_iv_eo_pct",
  "default_alv_pct",
  "default_nbu_pct",
  "default_bvg_pct",
  "default_ktg_pct",
  "default_quellensteuer_pct",
  "default_employer_ahv_pct",
  "default_employer_alv_pct",
  "default_employer_fak_pct",
  "default_employer_bu_pct",
  "default_employer_bvg_pct",
  "default_employer_verwaltung_pct",
] as const;

const SELECT_COLS = `id, effective_from, ${PCT_COLUMNS.join(", ")}, bvg_threshold_chf, notes, created_at, updated_at, created_by`;

function coerceNum(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function coerceDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

// -----------------------------------------------------------------
// GET — alle Zeilen liefern (Client teilt in current/future/history)
// -----------------------------------------------------------------
export async function GET() {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const [rowsRes, standardCountRes, overrideCountRes] = await Promise.all([
    admin.from("payroll_defaults").select(SELECT_COLS).order("effective_from", { ascending: false }),
    // Reichweiten-Anzeige: wieviele aktive MA nutzen den Firmen-Standard,
    // wieviele haben eigene Overrides — damit die UI zeigen kann "X von Y MA
    // ziehen die neuen Saetze automatisch mit, Z sind eingefroren".
    admin.from("employee_compensation")
      .select("id", { count: "exact", head: true })
      .is("effective_to", null)
      .neq("wage_exempt", true)
      .or("uses_standard_lohn.is.null,uses_standard_lohn.eq.true"),
    admin.from("employee_compensation")
      .select("id", { count: "exact", head: true })
      .is("effective_to", null)
      .neq("wage_exempt", true)
      .eq("uses_standard_lohn", false),
  ]);
  if (rowsRes.error) return NextResponse.json({ success: false, error: rowsRes.error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    rows: rowsRes.data ?? [],
    today: todayLocalIso(),
    impact: {
      standard: standardCountRes.count ?? 0,
      override: overrideCountRes.count ?? 0,
    },
  });
}

// -----------------------------------------------------------------
// POST — neue Zeile anlegen (fuer Jahres-Wechsel etc.)
// -----------------------------------------------------------------
export async function POST(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ success: false, error: "Ungueltiger Body" }, { status: 400 });
  }

  const effective_from = coerceDate(body.effective_from);
  if (!effective_from) {
    return NextResponse.json({ success: false, error: "effective_from erforderlich (YYYY-MM-DD)" }, { status: 400 });
  }
  // Retroaktive Insertion verhindern — sonst wuerden schon generierte
  // Lohnabrechnungen (die via asOf=Monatsanfang die zum Monat gueltige
  // Zeile picken) beim Regenerate mit neuen Saetzen rechnen. Historie
  // ist read-only.
  if (effective_from <= todayLocalIso()) {
    return NextResponse.json({
      success: false,
      error: `Neue Eintraege muessen in der Zukunft liegen (nach ${todayLocalIso()}). Aktuelle/historische Werte sind read-only.`,
    }, { status: 400 });
  }

  const row: Record<string, unknown> = { effective_from, created_by: auth.user.id };
  for (const col of PCT_COLUMNS) {
    const v = coerceNum(body[col]);
    if (v == null || v < 0 || v > 100) {
      return NextResponse.json({ success: false, error: `${col} erforderlich (0-100)` }, { status: 400 });
    }
    row[col] = v;
  }
  const bvg = coerceNum(body.bvg_threshold_chf);
  if (bvg == null || bvg < 0) {
    return NextResponse.json({ success: false, error: "bvg_threshold_chf erforderlich" }, { status: 400 });
  }
  row.bvg_threshold_chf = bvg;
  if (typeof body.notes === "string") row.notes = body.notes.trim() || null;

  const { data, error } = await createAdminClient()
    .from("payroll_defaults")
    .insert(row)
    .select(SELECT_COLS)
    .single();
  if (error) {
    // UNIQUE-Verletzung auf effective_from -> sprechender Fehler
    if (error.code === "23505") {
      return NextResponse.json({
        success: false,
        error: `Fuer den ${effective_from} existiert bereits ein Datensatz. Bearbeite den bestehenden Eintrag statt einen neuen anzulegen.`,
      }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, row: data });
}

// -----------------------------------------------------------------
// PATCH — bestehende Zeile aktualisieren
// -----------------------------------------------------------------
export async function PATCH(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string") {
    return NextResponse.json({ success: false, error: "id erforderlich" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Werte-Update ist auf ALLEN Zeilen zugelassen (auch aktuelle/historische)
  // — Admin muss Tippfehler korrigieren koennen. UI zeigt beim Editieren
  // der aktuellen/historischen Zeile eine Warnung: bereits generierte
  // Lohnabrechnungen aendern sich bei Regenerate. "Aendern ab einem
  // NEUEN Datum" ist der 'Neuer Stichtag'-Weg (POST + effective_from).
  const patch: Record<string, unknown> = {};
  for (const col of PCT_COLUMNS) {
    if (!(col in body)) continue;
    const v = coerceNum(body[col]);
    if (v == null || v < 0 || v > 100) {
      return NextResponse.json({ success: false, error: `${col} ungueltig (0-100)` }, { status: 400 });
    }
    patch[col] = v;
  }
  if ("bvg_threshold_chf" in body) {
    const bvg = coerceNum(body.bvg_threshold_chf);
    if (bvg == null || bvg < 0) {
      return NextResponse.json({ success: false, error: "bvg_threshold_chf ungueltig" }, { status: 400 });
    }
    patch.bvg_threshold_chf = bvg;
  }
  if ("effective_from" in body) {
    const ef = coerceDate(body.effective_from);
    if (!ef) return NextResponse.json({ success: false, error: "effective_from ungueltig" }, { status: 400 });
    patch.effective_from = ef;
  }
  if ("notes" in body) {
    patch.notes = typeof body.notes === "string" ? (body.notes.trim() || null) : null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ success: false, error: "Keine Felder zum Updaten" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("payroll_defaults")
    .update(patch)
    .eq("id", body.id)
    .select(SELECT_COLS)
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({
        success: false,
        error: "Ein anderer Eintrag hat bereits dieses effective_from-Datum.",
      }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, row: data });
}

// -----------------------------------------------------------------
// DELETE — nur zukuenftige/geplante Zeilen loeschen
// -----------------------------------------------------------------
export async function DELETE(request: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "id erforderlich" }, { status: 400 });

  const admin = createAdminClient();
  const { data: row, error: getErr } = await admin
    .from("payroll_defaults")
    .select("id, effective_from")
    .eq("id", id)
    .maybeSingle();
  if (getErr) return NextResponse.json({ success: false, error: getErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ success: false, error: "Eintrag nicht gefunden" }, { status: 404 });

  const today = todayLocalIso();
  if (row.effective_from <= today) {
    return NextResponse.json({
      success: false,
      error: "Nur zukuenftige/geplante Eintraege koennen geloescht werden — historische Werte bleiben fuer die Nachvollziehbarkeit der Lohnabrechnungen erhalten.",
    }, { status: 400 });
  }

  // Verhindere Loeschung der letzten verbliebenen Zeile (sollte im
  // Delete-nur-Zukunft-Fall eh nicht auftreten, aber Belt-and-Suspenders).
  const { count } = await admin
    .from("payroll_defaults")
    .select("id", { count: "exact", head: true });
  if ((count ?? 0) <= 1) {
    return NextResponse.json({ success: false, error: "Der letzte Eintrag kann nicht geloescht werden." }, { status: 400 });
  }

  const { error: delErr } = await admin.from("payroll_defaults").delete().eq("id", id);
  if (delErr) return NextResponse.json({ success: false, error: delErr.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
