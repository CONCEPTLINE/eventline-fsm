// BVG-Ampel (Kalender-Woche, Termin-Zuweisung in Aufträgen) — Lohn-Umbau Phase 1.
//
// Früher lasen Kalender und Aufträge die Stundenlöhne direkt im Browser aus
// employee_compensation. Jetzt rechnet der Server und gibt nur die Prognose
// zurück; der Browser hat keine Rechte mehr auf die Lohnzeilen (Migration 362).
//
// Zugriff: Lohnrecht (lohn:manage) — bewusst OHNE Gerätezwang, damit die
// Ampel wie bisher auch am Handy geht (Plan Phase 1, «Zugriff»). Ohne
// vertrautes Gerät gibt es NUR die Ampel (status ok/warn/crit), keine
// Beträge — aus «CHF bei 1 h Termin» liesse sich sonst der Stundenlohn
// ablesen (Gegenprüfung Phase 1). Mit vertrautem Gerät zusätzlich die
// CHF-Prognose wie bisher. POST ist begrenzt (Datum ±400 Tage, Termin
// höchstens 24 h, höchstens 50 Personen).
//
// GET  ?monat=YYYY-MM
//      → { personen: { [profile_id]: { chf|null, threshold, status } } } für alle
//        Personen mit Terminen im Monat (Kalender-Wochenansicht).
// POST { datum: YYYY-MM-DD, start_time, end_time, personen: uuid[] }
//      → { threshold, zeilen: [{ profile_id, current|null, after|null, status }] }
//        Prognose vor/nach einem neuen Termin (Warnung beim Zuweisen).
//
// Rechnung unverändert (src/lib/bvg-forecast.ts): Lohn = heute gültige
// Lohnzeile, Schwelle = Firmen-Standardwert zum Monat bzw. Termin-Datum.

import { NextResponse } from "next/server";
import { requirePermission, pruefeVertrautesGeraet } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { calculateForecast, forecastStatus, monthRange } from "@/lib/bvg-forecast";
import { plusTage, todayLocalIso } from "@/lib/swiss-time";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { isUuid } from "@/lib/search-escape";

type Termin = { start_time: string; end_time: string | null };

async function heutigeLoehne(admin: ReturnType<typeof createAdminClient>, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const today = todayLocalIso();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin
      .from("employee_compensation")
      .select("profile_id, hourly_wage_chf, effective_from, effective_to")
      .in("profile_id", ids.slice(i, i + 200))
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`);
    if (error) throw new Error(`Lohnzeilen: ${error.message}`);
    for (const c of data ?? []) out.set(c.profile_id as string, Number(c.hourly_wage_chf));
  }
  return out;
}

async function schwelle(admin: ReturnType<typeof createAdminClient>, asOf: string): Promise<number> {
  const { data, error } = await admin.rpc("get_current_bvg_threshold", { p_as_of: asOf });
  if (error) throw new Error(`BVG-Schwelle: ${error.message}`);
  return Number(data ?? 1837.5);
}

function monatAusParam(v: string | null): { jahr: number; monat: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(v ?? "");
  if (!m) return null;
  const jahr = Number(m[1]);
  const monat = Number(m[2]);
  return monat >= 1 && monat <= 12 ? { jahr, monat } : null;
}

export async function GET(request: Request) {
  const auth = await requirePermission(LOHN_RECHT);
  if (auth.error) return auth.error;
  const p = monatAusParam(new URL(request.url).searchParams.get("monat"));
  if (!p) return NextResponse.json({ success: false, error: "monat=YYYY-MM fehlt" }, { status: 400 });

  try {
    const admin = createAdminClient();
    const m = monthRange(p.jahr, p.monat);
    const [threshold, apptsRes] = await Promise.all([
      schwelle(admin, m.start),
      admin
        .from("job_appointments")
        .select("assigned_to, start_time, end_time")
        .gte("start_time", `${m.start}T00:00:00Z`)
        .lt("start_time", `${m.end}T23:59:59Z`)
        .not("assigned_to", "is", null)
        .limit(10000),
    ]);
    if (apptsRes.error) throw new Error(`Termine: ${apptsRes.error.message}`);
    const proPerson = new Map<string, Termin[]>();
    for (const a of (apptsRes.data ?? []) as { assigned_to: string; start_time: string; end_time: string | null }[]) {
      const l = proPerson.get(a.assigned_to) ?? [];
      l.push({ start_time: a.start_time, end_time: a.end_time });
      proPerson.set(a.assigned_to, l);
    }
    const loehne = await heutigeLoehne(admin, Array.from(proPerson.keys()));
    const mitBetraegen = (await pruefeVertrautesGeraet(auth.user.id)) === "vertraut";
    const personen: Record<string, { chf: number | null; threshold: number; status: "ok" | "warn" | "crit" }> = {};
    for (const [id, termine] of proPerson) {
      const lohn = loehne.get(id);
      if (!lohn) continue;
      const chf = calculateForecast(termine, lohn, m.start, m.end).total_chf;
      personen[id] = { chf: mitBetraegen ? chf : null, threshold, status: forecastStatus(chf, threshold) };
    }
    return NextResponse.json({ success: true, mit_betraegen: mitBetraegen, personen });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requirePermission(LOHN_RECHT);
  if (auth.error) return auth.error;
  const body = (await request.json().catch(() => null)) as
    | { datum?: unknown; start_time?: unknown; end_time?: unknown; personen?: unknown }
    | null;
  const datum = typeof body?.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.datum) ? body.datum : null;
  const start = typeof body?.start_time === "string" ? body.start_time : null;
  const ende = typeof body?.end_time === "string" ? body.end_time : null;
  const personen = Array.isArray(body?.personen) ? (body!.personen as unknown[]).filter((x): x is string => typeof x === "string" && isUuid(x)) : [];
  if (!datum || !start || !ende || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(ende))) {
    return NextResponse.json({ success: false, error: "datum, start_time, end_time nötig" }, { status: 400 });
  }
  if (personen.length === 0) return NextResponse.json({ success: true, threshold: null, zeilen: [] });
  const heute = todayLocalIso();
  const dauerMs = Date.parse(ende) - Date.parse(start);
  if (datum < plusTage(heute, -400) || datum > plusTage(heute, 400) || dauerMs <= 0 || dauerMs > 24 * 3600_000 || personen.length > 50) {
    return NextResponse.json({ success: false, error: "Termin ausserhalb des Prüfbereichs (Datum ±400 Tage, Dauer bis 24 h, bis 50 Personen)" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const m = monthRange(Number(datum.slice(0, 4)), Number(datum.slice(5, 7)));
    const [threshold, loehne, apptsRes] = await Promise.all([
      schwelle(admin, datum),
      heutigeLoehne(admin, personen),
      admin
        .from("job_appointments")
        .select("assigned_to, start_time, end_time")
        .in("assigned_to", personen)
        .gte("start_time", `${m.start}T00:00:00Z`)
        .lt("start_time", `${m.end}T23:59:59Z`)
        .limit(10000),
    ]);
    if (apptsRes.error) throw new Error(`Termine: ${apptsRes.error.message}`);
    const mitBetraegen = (await pruefeVertrautesGeraet(auth.user.id)) === "vertraut";
    const zeilen: { profile_id: string; current: number | null; after: number | null; status: "ok" | "warn" | "crit" }[] = [];
    for (const id of personen) {
      const lohn = loehne.get(id);
      if (!lohn) continue;
      const bisher = ((apptsRes.data ?? []) as { assigned_to: string; start_time: string; end_time: string | null }[])
        .filter((r) => r.assigned_to === id)
        .map((r) => ({ start_time: r.start_time, end_time: r.end_time }));
      const current = calculateForecast(bisher, lohn, m.start, m.end).total_chf;
      const after = calculateForecast([...bisher, { start_time: start, end_time: ende }], lohn, m.start, m.end).total_chf;
      zeilen.push({
        profile_id: id,
        current: mitBetraegen ? current : null,
        after: mitBetraegen ? after : null,
        status: forecastStatus(after, threshold),
      });
    }
    return NextResponse.json({ success: true, threshold, mit_betraegen: mitBetraegen, zeilen });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
