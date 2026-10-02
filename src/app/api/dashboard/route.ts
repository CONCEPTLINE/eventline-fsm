// GET /api/dashboard — konfigurierbares Cockpit-Bundle fuer die Startseite.
//
// Neu (Migration 207): die Rueckgabe folgt einer 3-Ebenen-Konfiguration.
//   Ebene 1  Registry (src/lib/dashboard-widgets.ts) — alle Widget-IDs
//            + Permission-Requirements + Default-Rollen.
//   Ebene 2  Rollen-Override (roles.dashboard_widgets) — pro Rolle
//            {order, hidden}; NULL = Registry-Default fuer diese Rolle.
//   Ebene 3  User-Override (user_dashboard_overrides) — pro User
//            {hidden, widget_order}; leer = Rollen-Zustand uebernehmen.
//
// Merge (deterministisch, kein DB-Sort):
//   roleVisible = roleOrder \ roleHidden   (Registry-unbekannte gefiltert)
//   final       = userOrder (nur was noch in roleVisible und nicht user-
//                            hidden ist) ++ roleVisible-Rest in Rollen-
//                                            Reihenfolge (auch nicht user-hidden).
//   dann Permission-Filter (Admin durch): jedes Widget dessen `requires` der
//   User nicht erfuellt, wird SERVER-seitig entfernt — kein Payload leakt.
//
// Payload-Bau:
//   Wir laden loadAdminData() nur, wenn irgendein Admin-Widget im finalen
//   Set steckt (analog loadMaData). Spart die 10 Counts-Queries fuer reine
//   Techniker-Dashboards und die MA-Compensation-Queries fuer reine Admins.
//
// Response-Shape (rueckwaerts-kompatibel + neu):
//   {
//     success, role, first_name,
//     widgets: string[],           // NEU: sichtbare Widget-IDs in Reihenfolge
//     widget_catalog: [{id,title,requires}], // NEU: Katalog fuer Zahnrad-Modal
//     admin?: {kpi, zu_erledigen, team_status, overdue_jobs},
//     ma?:    {monat_stunden, ist_lohn_chf, wage_exempt, hourly_wage_chf,
//              prognose_stunden, prognose_lohn_chf, naechster_einsatz},
//   }
//   Sensible Zahlen (Lohn): via Admin-Client, aber STRIKT profile_id == user.id.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cachedRoles } from "@/lib/cached";
import {
  bucketizeMinutes,
  todayLocalIso,
  localDateIso,
  type MinuteBucket,
} from "@/lib/swiss-time";
import {
  loadLohnDefaults,
  effectivePcts,
  sumEmployeePct,
  type PctComp,
} from "@/lib/employer-costs";
import {
  DASHBOARD_WIDGETS,
  widgetsForRole,
  type WidgetId,
} from "@/lib/dashboard-widgets";
import { hasPermission } from "@/lib/permissions";
// Firmen-Cockpit-Loader lebt in der Lib — geteilt mit dem Wand-Dashboard
// (/api/bildschirm/daten), damit beide dieselben Zahlen zeigen.
import { loadAdminData } from "@/lib/dashboard-admin-data";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Erster Tag des aktuellen Monats im Europe/Zurich-Kalender als YYYY-MM-DD. */
function currentMonthStartIso(): string {
  const today = todayLocalIso(); // YYYY-MM-DD
  return `${today.slice(0, 7)}-01`;
}

/** Startzeitstempel (UTC-ms) sicher vor Monatsanfang lokal. Nimmt
 *  monthStart YYYY-MM-DD und subtrahiert 2 Tage — damit sind alle
 *  time_entries des Monats sicher enthalten, egal was UTC-Offset macht. */
function safeUtcMsFromLocalDate(iso: string, subtractDays = 2): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - subtractDays * 24 * 3600 * 1000;
}

// ---------------------------------------------------------------------------
// Techniker: eigenes Cockpit
// ---------------------------------------------------------------------------

interface MaPayload {
  monat_stunden: number;
  ist_lohn_chf: number;
  wage_exempt: boolean;
  hourly_wage_chf: number | null;
  prognose_stunden: number;
  prognose_lohn_chf: number;
  naechster_einsatz: {
    id: string;
    title: string;
    start_time: string;
    end_time: string | null;
    job_number: number | null;
    job_title: string | null;
    customer_name: string | null;
  } | null;
}

async function loadMaData(userId: string): Promise<MaPayload> {
  const admin = createAdminClient();
  const monthStartIso = currentMonthStartIso(); // YYYY-MM-01
  const monthPrefix = monthStartIso.slice(0, 7); // YYYY-MM
  const nowMs = Date.now();
  const fetchFromMs = safeUtcMsFromLocalDate(monthStartIso, 2);
  // Sichere obere Grenze fuer Appointments-Fetch: erster Tag naechster Monat + 2 Tage.
  const [my, mm] = monthStartIso.split("-").map(Number);
  const monthEndSafeMs = Date.UTC(my, mm, 3); // mm=1..12 -> naechster-Monat-Index; +3 Tage Puffer
  const monthEndSafeIso = new Date(monthEndSafeMs).toISOString();

  // Compensation-Row des Users. Admin-Client umgeht RLS — wir filtern strikt
  // auf profile_id == userId, kein Fremd-Lohn-Leak moeglich.
  const [compRes, entriesRes, defaults, apptsMonthRes, nextApptRes] = await Promise.all([
    admin
      .from("employee_compensation")
      .select("hourly_wage_chf, uses_standard_lohn, wage_exempt, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, effective_from, effective_to")
      .eq("profile_id", userId)
      .lte("effective_from", todayLocalIso())
      .or(`effective_to.is.null,effective_to.gte.${todayLocalIso()}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("time_entries")
      .select("clock_in, clock_out")
      .eq("user_id", userId)
      .not("clock_out", "is", null)
      .gte("clock_in", new Date(fetchFromMs).toISOString()),
    loadLohnDefaults(admin, monthStartIso),
    // Alle eigenen Termine im aktuellen Monat (fuer Prognose)
    admin
      .from("job_appointments")
      .select("start_time, end_time")
      .eq("assigned_to", userId)
      .gte("start_time", new Date(fetchFromMs).toISOString())
      .lt("start_time", monthEndSafeIso),
    // Naechster eigener Termin (>= jetzt)
    admin
      .from("job_appointments")
      .select("id, title, start_time, end_time, job:jobs(job_number, title, customer:customers(name))")
      .eq("assigned_to", userId)
      .gte("start_time", new Date(nowMs).toISOString())
      .order("start_time", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  // §7 (nie stiller Fehlschlag): erster Fehler hochwerfen, damit der aeussere
  // try/catch in GET() 500 + Ursache liefert, statt ein Lohn-Payload mit
  // Nullen aus fehlgeschlagenen Queries.
  const maResErr =
    compRes.error ??
    entriesRes.error ??
    apptsMonthRes.error ??
    nextApptRes.error;
  if (maResErr) throw new Error(maResErr.message);

  // ------- Ist-Stunden diesen Monat (DST-safe via bucketize) -------
  type Entry = { clock_in: string; clock_out: string | null };
  const buckets = new Map<string, MinuteBucket>();
  for (const e of (entriesRes.data ?? []) as Entry[]) {
    if (!e.clock_out) continue;
    bucketizeMinutes(new Date(e.clock_in).getTime(), new Date(e.clock_out).getTime(), buckets);
  }
  let monatMinuten = 0;
  for (const b of buckets.values()) {
    if (b.date.startsWith(monthPrefix)) monatMinuten += b.total_minutes;
  }
  const monatStunden = Math.round((monatMinuten / 60) * 100) / 100;

  // ------- Compensation-Werte -------
  const comp = compRes.data as PctComp & {
    hourly_wage_chf?: number | string | null;
    wage_exempt?: boolean | null;
  } | null;
  const wageExempt = comp?.wage_exempt === true;
  // NaN-Guard: DB koennte Muell liefern (String, "N/A", etc.). Nicht-endliche
  // Werte fallback auf null — ist-Lohn/Prognose gehen dann sauber auf 0.
  const hourlyWage = (() => {
    if (comp?.hourly_wage_chf == null) return null;
    const n = Number(comp.hourly_wage_chf);
    return Number.isFinite(n) ? n : null;
  })();
  const pcts = effectivePcts(comp, defaults);
  const employeeDeductionPct = sumEmployeePct(pcts);
  const nettoFactor = 1 - employeeDeductionPct / 100;

  const istLohn = wageExempt || hourlyWage == null
    ? 0
    : Math.round(monatStunden * hourlyWage * nettoFactor * 100) / 100;

  // ------- Prognose: Ist + zukuenftige geplante Stunden diesen Monat -------
  type Appt = { start_time: string; end_time: string | null };
  let plannedMinuten = 0;
  const nowIso = new Date(nowMs).toISOString();
  for (const a of (apptsMonthRes.data ?? []) as Appt[]) {
    if (!a.end_time) continue;
    // Nur Termine die in DER LOKALEN Monatsansicht liegen und noch nicht
    // vorbei sind. Vergangene Termine sind entweder schon per Stempel
    // erfasst oder gar nicht stattgefunden — beides Wille nicht doppelzaehlen.
    if (a.start_time < nowIso) continue;
    const startDate = localDateIso(new Date(a.start_time));
    if (!startDate.startsWith(monthPrefix)) continue;
    const durMs = new Date(a.end_time).getTime() - new Date(a.start_time).getTime();
    if (durMs > 0) plannedMinuten += durMs / 60000;
  }
  const prognoseStunden = Math.round((monatStunden + plannedMinuten / 60) * 100) / 100;
  const prognoseLohn = wageExempt || hourlyWage == null
    ? 0
    : Math.round(prognoseStunden * hourlyWage * nettoFactor * 100) / 100;

  // ------- Naechster Einsatz -------
  const nextRow = nextApptRes.data as {
    id: string;
    title: string;
    start_time: string;
    end_time: string | null;
    job: {
      job_number: number | null;
      title: string;
      customer: { name: string } | null;
    } | null;
  } | null;
  const naechster = nextRow
    ? {
        id: nextRow.id,
        title: nextRow.title,
        start_time: nextRow.start_time,
        end_time: nextRow.end_time,
        job_number: nextRow.job?.job_number ?? null,
        job_title: nextRow.job?.title ?? null,
        customer_name: nextRow.job?.customer?.name ?? null,
      }
    : null;

  return {
    monat_stunden: monatStunden,
    ist_lohn_chf: istLohn,
    wage_exempt: wageExempt,
    hourly_wage_chf: hourlyWage,
    prognose_stunden: prognoseStunden,
    prognose_lohn_chf: prognoseLohn,
    naechster_einsatz: naechster,
  };
}

// ---------------------------------------------------------------------------
// Widget-Merge & Loader-Selection
// ---------------------------------------------------------------------------

/** Loader-Mapping: welche Widgets brauchen welchen Payload-Loader. Bewusst
 *  hier lokal (nicht in der Registry) — die Registry bleibt UI-neutrales
 *  Config-Data, das Loader-Mapping ist ein Backend-Detail dieser Route.
 *
 *  Widgets ohne Eintrag (anwesenheitskalender, partner-willkommen) laden
 *  ihre Daten selbst clientseitig — sie brauchen nichts aus admin/ma-Payload. */
type WidgetLoader = "admin" | "ma";
const WIDGET_LOADERS: Partial<Record<WidgetId, WidgetLoader>> = {
  "kpi-offene-auftraege": "admin",
  "kpi-termine-woche": "admin",
  "kpi-nicht-abgerechnet": "admin",
  "overdue-jobs": "admin",
  "zu-erledigen": "admin",
  "team-status": "admin",
  "ma-monat-stunden": "ma",
  "ma-prognose": "ma",
  "ma-naechster-einsatz": "ma",
};

/** Fuegt Rollen- + User-Overrides deterministisch zusammen — siehe Kopf-Doku.
 *  Rueckgabe: Widget-IDs die auf dem Dashboard erscheinen sollen, in
 *  Anzeige-Reihenfolge. Permission-Filter passiert separat spaeter. */
function resolveVisibleWidgets(params: {
  role: string;
  /** Permissions der Rolle — fuer den widgetsForRole-Fallback bei frei
   *  definierten Rollen ohne defaultRoles-Match (sonst leeres Dashboard). */
  permissions: string[];
  roleOverride: { order: string[]; hidden: string[] } | null;
  userOverride: { hidden: string[]; widget_order: string[] } | null;
}): WidgetId[] {
  const knownIds = new Set(DASHBOARD_WIDGETS.map((w) => w.id));

  // Ebene 2: Rollen-Set. NULL / leer / kaputt -> Registry-Default fuer die Rolle.
  const roleOrderRaw = params.roleOverride?.order ?? [];
  const roleHiddenRaw = new Set(params.roleOverride?.hidden ?? []);
  const roleOrder = (roleOrderRaw.length > 0 ? roleOrderRaw : widgetsForRole(params.role, params.permissions))
    .filter((id): id is WidgetId => knownIds.has(id as WidgetId));
  const roleVisible = roleOrder.filter((id) => !roleHiddenRaw.has(id));

  // Ebene 3: User-Override.
  const userHidden = new Set(params.userOverride?.hidden ?? []);
  const userOrder = params.userOverride?.widget_order ?? [];

  // Greedy Merge: erst vom User bevorzugte IDs in seiner Reihenfolge,
  // dann Rest in Rollen-Reihenfolge — jeweils nur wenn im Rollen-Set und
  // nicht user-hidden.
  const seen = new Set<WidgetId>();
  const result: WidgetId[] = [];
  for (const raw of userOrder) {
    if (!knownIds.has(raw as WidgetId)) continue;
    const id = raw as WidgetId;
    if (!roleVisible.includes(id)) continue;
    if (userHidden.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of roleVisible) {
    if (userHidden.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Katalog fuer das Zahnrad-Modal — reine Metadaten, kein Payload. Damit
 *  der Client alle Widgets zum Ein-/Ausblenden anbieten kann, egal ob sie
 *  gerade sichtbar sind. */
const WIDGET_CATALOG = DASHBOARD_WIDGETS.map((w) => ({
  id: w.id,
  title: w.title,
  requires: w.requires,
}));

/** Subtitle unter dem Gruss. Serverseitig weil hier die Rolle bekannt ist —
 *  frueher hat der Client hardcoded auf "admin"/"techniker"/"partner"-Slugs
 *  gematcht, was mit dem frei-definierbaren Rollen-System bricht. */
function subtitleForRole(role: string): string {
  if (role === "admin") return "Was jetzt wichtig ist";
  if (role === "techniker") return "Dein Monat auf einen Blick";
  if (role === "partner") return "Willkommen im Portal";
  return "";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const supabase = await createClient();
  const admin = createAdminClient();

  // Profile via anon-Client (RLS: eigenes Profil), Rolle + User-Override
  // via Admin-Client, damit die Route auch wenn die roles-RLS mal restriktiv
  // wird stabil weiter laeuft und ein User-Override immer geladen wird (der
  // User darf sein eigenes lesen, aber wir vermeiden RLS-Reibung).
  //
  // Der User-Override haengt NUR an effectiveUserId → Query sofort starten,
  // parallel zur Profile-Query. Promise.resolve() zwingt den lazy
  // Supabase-Builder, den Request jetzt abzuschicken statt erst beim await.
  const overridePromise = Promise.resolve(
    admin
      .from("user_dashboard_overrides")
      .select("hidden, widget_order, widget_spans")
      // dev-mode: effective user
      .eq("user_id", auth.effectiveUserId)
      .maybeSingle(),
  );

  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("role, full_name")
    // dev-mode: effective user
    .eq("id", auth.effectiveUserId)
    .single();
  if (profErr || !profile) {
    return NextResponse.json({ success: false, error: "Profil nicht gefunden" }, { status: 500 });
  }

  const firstName = (profile.full_name ?? "").split(" ")[0] ?? "";
  const role = profile.role ?? "";

  try {
    const [roleRow, overrideRes] = await Promise.all([
      // §9-Cache: ganze roles-Tabelle (Handvoll Zeilen) via cachedRoles()
      // — Tag "roles", von den Rollen-Schreibrouten sofort invalidiert —,
      // lokal auf den Slug matchen. Semantik wie das bisherige maybeSingle
      // (fehlende Rolle → null), aber meist ohne DB-Roundtrip. .catch()
      // erhaelt die bisherige Fehlertoleranz (Query-Fehler ≙ Rolle fehlt).
      cachedRoles()
        .then((rows) => rows.find((r) => r.slug === role) ?? null)
        .catch(() => null),
      overridePromise, // laeuft schon seit vor der Profile-Query
    ]);

    // permissions kommt aus jsonb — cachedRoles liefert bereits string[].
    const permissions: string[] = roleRow?.permissions ?? [];

    // Rollen-Override: jsonb {order, hidden} oder NULL.
    let roleOverride: { order: string[]; hidden: string[] } | null = null;
    const rw = roleRow?.dashboard_widgets as unknown;
    if (rw && typeof rw === "object" && !Array.isArray(rw)) {
      const obj = rw as { order?: unknown; hidden?: unknown };
      const order = Array.isArray(obj.order)
        ? obj.order.filter((s): s is string => typeof s === "string")
        : [];
      const hidden = Array.isArray(obj.hidden)
        ? obj.hidden.filter((s): s is string => typeof s === "string")
        : [];
      roleOverride = { order, hidden };
    }

    const userOverride = overrideRes.data
      ? {
          hidden: (overrideRes.data.hidden ?? []) as string[],
          widget_order: (overrideRes.data.widget_order ?? []) as string[],
        }
      : null;
    // widget_spans wird separat durchgereicht (nicht Teil von resolveVisibleWidgets,
    // weil die Breite nur die Darstellung beeinflusst, nicht die Sichtbarkeit).
    const userWidgetSpans: Record<string, number> = (() => {
      const raw = overrideRes.data?.widget_spans as unknown;
      if (!raw || typeof raw !== "object") return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "number" && (v === 4 || v === 6 || v === 8 || v === 12)) {
          out[k] = v;
        }
      }
      return out;
    })();

    // 1) Rolle+User mergen (deterministisch).
    const merged = resolveVisibleWidgets({ role, permissions, roleOverride, userOverride });

    // 2) Permission-Filter (Admin durch — hasPermission gated).
    const widgets = merged.filter((id) => {
      const w = DASHBOARD_WIDGETS.find((x) => x.id === id);
      if (!w) return false;
      return w.requires.every((p) => hasPermission(permissions, role, p));
    });

    // 3) Payload gezielt laden — nur was ein sichtbares Widget wirklich braucht.
    const loadersNeeded = new Set<WidgetLoader>();
    for (const id of widgets) {
      const l = WIDGET_LOADERS[id];
      if (l) loadersNeeded.add(l);
    }
    // scope fuer Team-Status ermitteln: Admin ist implizit 'all' (analog
    // has_permission()/get_my_scope()). Sonst aus roles.scope, Default 'self'
    // wenn Spalte fehlt (aeltere Rolle vor Migration 208).
    const rawScope = roleRow?.scope;
    const roleScope: "self" | "team" | "all" =
      rawScope === "team" || rawScope === "all" || rawScope === "self"
        ? rawScope
        : "self";
    const effectiveScope: "self" | "team" | "all" =
      role === "admin" ? "all" : roleScope;
    const [adminData, maData] = await Promise.all([
      loadersNeeded.has("admin")
        // dev-mode: effective user
        ? loadAdminData({ userId: auth.effectiveUserId, scope: effectiveScope })
        : Promise.resolve(null),
      // dev-mode: effective user
      loadersNeeded.has("ma") ? loadMaData(auth.effectiveUserId) : Promise.resolve(null),
    ]);

    const body: Record<string, unknown> = {
      success: true,
      role,
      first_name: firstName,
      subtitle: subtitleForRole(role),
      widgets,
      widget_catalog: WIDGET_CATALOG,
      // Nur Overrides — Frontend faellt auf widgetDefaultSpan(id) zurueck
      // wenn eine ID fehlt. Leere Map == keine Overrides.
      widget_spans: userWidgetSpans,
    };
    if (adminData) body.admin = adminData;
    if (maData) body.ma = maData;

    // no-store: Dashboard-Payload enthaelt live-Zaehler (offene Auftraege,
    // Stempel-Status). 60s stale hiess: neuer Beleg -> Widget zeigt bis zu
    // 60s alten Count. Kein Grund zu cachen — die Requests sind billig.
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
