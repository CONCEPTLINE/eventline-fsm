// GET /api/dashboard — Daten fuer das feste Dashboard (Startseite).
//
// Das Dashboard ist fest gestaltet (src/lib/dashboard-bereiche.ts): Nutzer
// verschieben, verbreitern oder blenden nichts aus. Welche Bereiche jemand
// sieht, folgt aus der Rolle — Rechte, Sichtbereich (roles.scope) und den
// Rollen-Schaltern roles.dashboard_bereiche_aus (Migration 290). Admins sehen
// alle Firmen-Bereiche, aber keine persoenlichen (eigener Einsatz/Monat).
//
// Geladen werden NUR die Daten der sichtbaren Bereiche. «Anwesenheit» laedt
// ihre Daten selbst im Client (RPC + RLS, eigene Zeile bearbeitbar).
// «Als Naechstes» teilt sich die Quelle mit der Agenda des Buero-Bildschirms
// (ladeNaechsteAuftraege in src/lib/dashboard-admin-data.ts). «Meine Todos»
// liest mit dem Client des eingeloggten Users (RLS) — abgehakt wird im
// Client wie auf /todos.
//
// Sensible Zahlen (Lohn-Prognose in «Mein Monat»): Admin-Client, aber STRIKT
// profile_id == effektiver User — kein Fremd-Lohn-Leak moeglich.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cachedRoles } from "@/lib/cached";
import { bucketizeMinutes, todayLocalIso, localDateIso, type MinuteBucket } from "@/lib/swiss-time";
import { loadLohnDefaults, effectivePcts, sumEmployeePct, type PctComp } from "@/lib/employer-costs";
import { hasPermission } from "@/lib/permissions";
import { istIntern } from "@/lib/roles";
import { DASHBOARD_BEREICH_KEYS, sichtbareBereiche, type DashboardBereichKey } from "@/lib/dashboard-bereiche";
import { ladeAufmerksamkeit, ladeKennzahlen, ladeNaechsteAuftraege, ladeTeamStatus } from "@/lib/dashboard-admin-data";
import type { DashboardDaten, MonatDaten, NaechsterEinsatz, TodoEintrag, TodosDaten } from "@/components/dashboard/typen";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Bereich «Meine Todos»
// ---------------------------------------------------------------------------

const MAX_TODOS = 6;

/** Eigene offene Todos — dieselbe Menge wie der Sidebar-Zaehler
 *  (use-nav-counts.tsx: assigned_to = User, status offen, nicht geloescht),
 *  hier fuer den effektiven User (bei «Ansicht als» der angesehene).
 *  Je Faelligkeits-Gruppe eine Abfrage mit exakter Anzahl und hoechstens 6
 *  Zeilen: ueberfaellig (aelteste zuerst), heute, spaeter (Datum
 *  aufsteigend), ohne Datum (neueste zuerst) — in jeder Gruppe «dringend»
 *  zuerst. Aneinandergehaengt ergeben sie die Reihenfolge der Karte, die
 *  Anzahlen die Zaehler fuer Karte und Kopf-Satz. «heute» im Zurich-Kalender. */
async function ladeMeineTodos(supabase: SupabaseClient, userId: string): Promise<TodosDaten> {
  const heute = todayLocalIso();
  const offen = () =>
    supabase
      .from("todos")
      .select("id, title, due_date, priority, status", { count: "exact" })
      .eq("assigned_to", userId)
      .eq("status", "offen")
      .is("deleted_at", null);
  // priority ist Text: "dringend" < "normal" — aufsteigend = dringend zuerst
  // (wie die Sortierung auf /todos, src/lib/todos-query.ts).
  const [ueberfaellig, heuteFaellig, spaeter, ohneDatum] = await Promise.all([
    offen()
      .lt("due_date", heute)
      .order("priority", { ascending: true })
      .order("due_date", { ascending: true })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_TODOS),
    offen()
      .eq("due_date", heute)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_TODOS),
    offen()
      .gt("due_date", heute)
      .order("priority", { ascending: true })
      .order("due_date", { ascending: true })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_TODOS),
    offen()
      .is("due_date", null)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_TODOS),
  ]);
  const gruppen = [ueberfaellig, heuteFaellig, spaeter, ohneDatum];
  const err = gruppen.find((g) => g.error)?.error;
  if (err) throw new Error(err.message);
  // Anzahl nie kleiner als die gelieferten Zeilen (count fehlt nur im Fehlerfall).
  const anzahl = (g: (typeof gruppen)[number]) => Math.max(g.count ?? 0, g.data?.length ?? 0);
  const nUeberfaellig = anzahl(ueberfaellig);
  const nHeute = anzahl(heuteFaellig);
  return {
    eintraege: gruppen.flatMap((g) => (g.data ?? []) as TodoEintrag[]).slice(0, MAX_TODOS),
    offen: gruppen.reduce((n, g) => n + anzahl(g), 0),
    faellig: nUeberfaellig + nHeute,
    ueberfaellig: nUeberfaellig,
  };
}

// ---------------------------------------------------------------------------
// Bereich «Naechster Einsatz»
// ---------------------------------------------------------------------------

type EinsatzJob = {
  id: string;
  job_number: number | null;
  title: string;
  external_address: string | null;
  location: { name: string } | null;
  room: { name: string } | null;
};
type EinsatzRow = { id: string; title: string; start_time: string; end_time: string | null; job: EinsatzJob | null };

/** Naechster eigener Termin ab jetzt. Termine stornierter oder geloeschter
 *  Auftraege zaehlen nicht (gleich wie Kalender-Export und Buero-Bildschirm);
 *  Termine ohne Auftrag (z. B. Schluesselrueckgabe) schon. */
async function ladeNaechsterEinsatz(userId: string): Promise<NaechsterEinsatz | null> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const [mitAuftragRes, ohneAuftragRes] = await Promise.all([
    admin
      .from("job_appointments")
      .select(
        "id, title, start_time, end_time, " +
          "job:jobs!inner(id, job_number, title, status, is_deleted, external_address, location:locations(name), room:rooms(name))",
      )
      .eq("assigned_to", userId)
      .gte("start_time", nowIso)
      .not("job.is_deleted", "is", true)
      .neq("job.status", "storniert")
      .order("start_time", { ascending: true })
      .limit(1)
      .maybeSingle(),
    admin
      .from("job_appointments")
      .select("id, title, start_time, end_time")
      .eq("assigned_to", userId)
      .is("job_id", null)
      .gte("start_time", nowIso)
      .order("start_time", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const err = mitAuftragRes.error ?? ohneAuftragRes.error;
  if (err) throw new Error(err.message);

  const mit = mitAuftragRes.data as unknown as EinsatzRow | null;
  const ohne = ohneAuftragRes.data as unknown as Omit<EinsatzRow, "job"> | null;
  const row: EinsatzRow | null =
    mit && (!ohne || Date.parse(mit.start_time) <= Date.parse(ohne.start_time))
      ? mit
      : ohne
      ? { ...ohne, job: null }
      : null;
  if (!row) return null;

  const job = row.job;
  const terminTitel = (row.title ?? "").trim();
  const titel = job?.title?.trim() || terminTitel || "Einsatz";
  const aufgabe =
    job && terminTitel && terminTitel.toLocaleLowerCase("de-CH") !== titel.toLocaleLowerCase("de-CH")
      ? terminTitel
      : null;
  return {
    id: row.id,
    start: row.start_time,
    ende: row.end_time,
    job_id: job?.id ?? null,
    auftrag_nr: job?.job_number ?? null,
    titel,
    aufgabe,
    ort: job?.location?.name ?? job?.room?.name ?? null,
    adresse: job?.location || job?.room ? null : job?.external_address?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Bereich «Mein Monat»
// ---------------------------------------------------------------------------

/** Startzeitstempel (UTC-ms) sicher vor Monatsanfang lokal: monthStart
 *  YYYY-MM-DD minus 2 Tage — damit sind alle time_entries des Monats sicher
 *  enthalten, egal was der UTC-Offset macht. */
function safeUtcMsFromLocalDate(iso: string, subtractDays = 2): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - subtractDays * 24 * 3600 * 1000;
}

async function ladeMeinMonat(userId: string): Promise<MonatDaten> {
  const admin = createAdminClient();
  const today = todayLocalIso(); // YYYY-MM-DD (Zurich)
  const monthPrefix = today.slice(0, 7); // YYYY-MM
  const monthStartIso = `${monthPrefix}-01`;
  const [y, m] = monthStartIso.split("-").map(Number);
  const nowMs = Date.now();
  const fetchFromIso = new Date(safeUtcMsFromLocalDate(monthStartIso, 2)).toISOString();
  // Sichere obere Grenze: erster Tag naechster Monat + 2 Tage Puffer.
  const monthEndSafeIso = new Date(Date.UTC(y, m, 3)).toISOString();

  // Compensation-Row des Users. Admin-Client umgeht RLS — wir filtern strikt
  // auf profile_id == userId, kein Fremd-Lohn-Leak moeglich.
  const [compRes, entriesRes, defaults, apptsRes] = await Promise.all([
    admin
      .from("employee_compensation")
      .select("hourly_wage_chf, uses_standard_lohn, wage_exempt, ahv_iv_eo_pct, alv_pct, nbu_pct, bvg_pct, ktg_pct, quellensteuer_pct, employer_ahv_pct, employer_alv_pct, employer_fak_pct, employer_bu_pct, employer_bvg_pct, employer_verwaltung_pct, effective_from, effective_to")
      .eq("profile_id", userId)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("time_entries")
      .select("clock_in, clock_out")
      .eq("user_id", userId)
      .not("clock_out", "is", null)
      .gte("clock_in", fetchFromIso),
    loadLohnDefaults(admin, monthStartIso),
    // Eigene Termine im Monat (fuer die Prognose) — mit Auftrags-Status,
    // damit stornierte/geloeschte Auftraege nicht mitzaehlen.
    admin
      .from("job_appointments")
      .select("start_time, end_time, job:jobs(status, is_deleted)")
      .eq("assigned_to", userId)
      .gte("start_time", fetchFromIso)
      .lt("start_time", monthEndSafeIso),
  ]);
  // §7: erster Fehler hoch → 500 + Ursache statt Prognose aus Nullen.
  const err = compRes.error ?? entriesRes.error ?? apptsRes.error;
  if (err) throw new Error(err.message);

  // ------- Ist-Stunden diesen Monat (DST-safe via bucketize) -------
  const buckets = new Map<string, MinuteBucket>();
  for (const e of (entriesRes.data ?? []) as { clock_in: string; clock_out: string | null }[]) {
    if (!e.clock_out) continue;
    bucketizeMinutes(new Date(e.clock_in).getTime(), new Date(e.clock_out).getTime(), buckets);
  }
  let monatMinuten = 0;
  for (const b of buckets.values()) {
    if (b.date.startsWith(monthPrefix)) monatMinuten += b.total_minutes;
  }
  const stunden = Math.round((monatMinuten / 60) * 100) / 100;

  // ------- Prognose: Ist + noch kommende geplante Termine diesen Monat -------
  // Vergangene Termine sind entweder schon per Stempel erfasst oder haben
  // nicht stattgefunden — beides nicht doppelt zaehlen.
  type Appt = {
    start_time: string;
    end_time: string | null;
    job: { status: string | null; is_deleted: boolean | null } | null;
  };
  const nowIso = new Date(nowMs).toISOString();
  let geplantMinuten = 0;
  for (const a of (apptsRes.data ?? []) as unknown as Appt[]) {
    if (!a.end_time || a.start_time < nowIso) continue;
    if (a.job && (a.job.status === "storniert" || a.job.is_deleted === true)) continue;
    if (!localDateIso(new Date(a.start_time)).startsWith(monthPrefix)) continue;
    const durMs = new Date(a.end_time).getTime() - new Date(a.start_time).getTime();
    if (durMs > 0) geplantMinuten += durMs / 60000;
  }
  const prognoseStunden = Math.round((stunden + geplantMinuten / 60) * 100) / 100;

  // ------- Lohn (netto) -------
  const comp = compRes.data as (PctComp & { hourly_wage_chf?: number | string | null; wage_exempt?: boolean | null }) | null;
  // NaN-Guard: nicht-endliche Werte gelten als «kein Stundensatz».
  const stundensatz = (() => {
    if (comp?.hourly_wage_chf == null) return null;
    const n = Number(comp.hourly_wage_chf);
    return Number.isFinite(n) ? n : null;
  })();
  const nettoFaktor = 1 - sumEmployeePct(effectivePcts(comp, defaults)) / 100;
  const prognoseChf =
    comp?.wage_exempt === true || stundensatz == null
      ? null
      : Math.round(prognoseStunden * stundensatz * nettoFaktor * 100) / 100;

  return {
    monat: monthPrefix,
    tag: Number(today.slice(8, 10)),
    tage_im_monat: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    stunden,
    prognose_stunden: prognoseStunden,
    prognose_chf: prognoseChf,
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  // dev-mode: effective user
  const userId = auth.effectiveUserId;

  const supabase = await createClient();
  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", userId)
    .single();
  if (profErr || !profile) {
    return NextResponse.json({ success: false, error: "Profil nicht gefunden" }, { status: 500 });
  }
  const role: string = profile.role ?? "";
  const vorname = (profile.full_name ?? "").trim().split(/\s+/)[0] ?? "";

  try {
    // §9-Cache: ganze roles-Tabelle (Handvoll Zeilen, Tag "roles" — die
    // Rollen-Schreibroute invalidiert sofort), lokal auf den Slug matchen.
    const roleRow = (await cachedRoles()).find((r) => r.slug === role) ?? null;
    const isAdmin = role === "admin";
    const permissions = roleRow?.permissions ?? [];
    const hat = (p: string) => hasPermission(permissions, role, p);
    // Admin ist implizit 'all' (analog has_permission()/get_my_scope()).
    const scope: "self" | "team" | "all" = isAdmin ? "all" : roleRow?.scope ?? "self";

    // Portal-Rollen (Partner/Lieferant) gehoeren nicht ins Firmen-Dashboard —
    // das (app)-Layout leitet sie in ihr Portal um.
    const sichtbar: Set<DashboardBereichKey> = istIntern(role)
      ? sichtbareBereiche({ isAdmin, hat, scope, aus: roleRow?.dashboard_bereiche_aus ?? [] })
      : new Set();
    const teamSicht: "team" | "alle" = scope === "team" ? "team" : "alle";

    const [kennzahlen, aufmerksamkeit, todos, personen, naechste, naechster, monat] = await Promise.all([
      sichtbar.has("kennzahlen")
        ? ladeKennzahlen({ auftraege: hat("auftraege:view"), termine: hat("kalender:view") })
        : null,
      // Je Zeile das Recht der Zielseite — ein Team-Leiter (tickets:manage,
      // kein ferien:approve) sieht Ueberfaellige, Partner-Anfragen und
      // Tickets, aber keine Abwesenheits-Antraege und nichts aus /abrechnung.
      sichtbar.has("aufmerksamkeit")
        ? ladeAufmerksamkeit({
            auftraege: hat("auftraege:view"),
            abwesenheit: hat("ferien:approve"),
            abrechnung: hat("abrechnung:view"),
            tickets: hat("tickets:manage"),
          })
        : null,
      sichtbar.has("todos") ? ladeMeineTodos(supabase, userId) : null,
      sichtbar.has("team")
        ? ladeTeamStatus(teamSicht === "team" ? { sicht: "team", userId } : { sicht: "alle" })
        : null,
      // Team-Sicht: nur Auftraege, in denen das eigene Team (oder man selbst)
      // eingeteilt ist. Sichtbereich «Nur ich» sieht den Bereich gar nicht.
      sichtbar.has("naechste")
        ? ladeNaechsteAuftraege(teamSicht === "team" ? { sicht: "team", userId } : { sicht: "alle" })
        : null,
      sichtbar.has("einsatz") ? ladeNaechsterEinsatz(userId) : null,
      sichtbar.has("monat") ? ladeMeinMonat(userId) : null,
    ]);

    const body: DashboardDaten = {
      success: true,
      vorname,
      bereiche: DASHBOARD_BEREICH_KEYS.filter((k) => sichtbar.has(k)),
      kennzahlen,
      aufmerksamkeit,
      todos,
      team: personen ? { sicht: teamSicht, personen } : null,
      naechste,
      einsatz: sichtbar.has("einsatz") ? { naechster } : null,
      monat,
    };
    // no-store: Live-Zaehler (Belege, Stempel-Status) — nie aus einem Cache.
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
