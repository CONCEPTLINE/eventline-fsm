/**
 * Eve-Tools — die Read-only-Toolbox die Gemini via Function-Calling
 * aufrufen kann. Alle Queries laufen mit der USER-Session (nicht
 * Service-Role), sodass RLS automatisch greift — Eve sieht nie mehr
 * als der User selbst sehen darf.
 *
 * Robust by default:
 *  - keine schreibenden Tools (kein update/insert/delete)
 *  - klare Param-Typen + Default-Limits damit Gemini nichts massiv ladet
 *  - Fehler werden als string-Result zurueckgegeben, sodass Eve
 *    transparent sagt "ich hab das nicht abrufen koennen"
 */

import { createClient } from "@/lib/supabase/server";

/** Schema-Beschreibung fuer Gemini's functionDeclarations. */
export const EVE_TOOL_DECLARATIONS = [
  {
    name: "get_current_user",
    description: "Gibt Profil des Users zurueck der gerade fragt (id, full_name, email, role). Aufrufen wenn die Frage 'mich' / 'ich' enthaelt.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_jobs",
    description: "Listet Auftraege mit Filtern. Statuses: anfrage, entwurf, offen, abgeschlossen, storniert. Default: aktive (alle ausser abgeschlossen+storniert), die naechsten 20 nach Datum.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Komma-Liste oder einzeln: 'anfrage,entwurf,offen' / 'abgeschlossen,storniert' / 'alle'" },
        customer_search: { type: "string", description: "Substring-Suche im Kundennamen" },
        location_search: { type: "string", description: "Substring-Suche im Locationnamen" },
        from_date: { type: "string", description: "YYYY-MM-DD, untere Grenze auf start_date" },
        to_date: { type: "string", description: "YYYY-MM-DD, obere Grenze auf start_date" },
        invoiced: { type: "string", description: "'yes' = nur abgerechnet, 'no' = nur unabrechnet, weglassen = beides" },
        limit: { type: "number", description: "Default 20, max 50" },
      },
    },
  },
  {
    name: "stempel_summary",
    description: "Aggregiert gestempelte Sessions + Minuten gruppiert nach User und Auftrag. Eine 'Session' = ein clock_in/clock_out-Zyklus. Returnt total_sessions, total_minutes, total_hours, plus by_user und by_job (mit jeweils sessions+minutes pro Eintrag). Defaults: aktueller User, diese Woche (Montag bis heute). Fuer 'wie viele Sessions/Stempelvorgaenge': Result.total_sessions oder by_user.[].sessions nutzen. Fuer eine bestimmte Person: user_search='Dario' oder vollstaendige Email.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", description: "'me' (default) | 'all' (alle User, fuer Admins) | 'user' (zusammen mit user_search fuer eine bestimmte Person)" },
        user_search: { type: "string", description: "Substring im full_name oder email. Triggert automatisch scope='user'. Beispiel: 'Dario' oder 'dario@'" },
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date: { type: "string", description: "YYYY-MM-DD" },
        job_number: { type: "number", description: "Filter auf einen bestimmten Auftrag" },
      },
    },
  },
  {
    name: "list_tickets",
    description: "Listet Tickets (Stempel-Aenderung, Material, Belege, sonstige). Default: nur offene, die letzten 20.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "stempel_aenderung | material | beleg | sonstiges" },
        status: { type: "string", description: "offen | erledigt | abgelehnt | alle (default offen)" },
        only_mine: { type: "boolean", description: "Nur Tickets vom aktuellen User" },
        limit: { type: "number", description: "Default 20" },
      },
    },
  },
  {
    name: "search_customers",
    description: "Sucht Kunden per Name-Substring. Liefert id, name, email, phone, address_city.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Pflicht: Substring im Namen" },
        limit: { type: "number", description: "Default 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_open_todos",
    description: "Listet noch nicht erledigte Todos. Default: dem User zugewiesen, die ersten 20.",
    parameters: {
      type: "object",
      properties: {
        only_mine: { type: "boolean", description: "Default true" },
        limit: { type: "number", description: "Default 20" },
      },
    },
  },
];

/* ----------- Tool-Handler ----------- */

type ToolArgs = Record<string, unknown>;

function clampLimit(n: unknown, fallback: number, max: number): number {
  const v = typeof n === "number" && n > 0 ? Math.floor(n) : fallback;
  return Math.min(v, max);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfWeek(): string {
  const d = new Date();
  const day = d.getDay() || 7; // Sonntag=0 → 7
  if (day !== 1) d.setDate(d.getDate() - (day - 1));
  d.setHours(0, 0, 0, 0);
  return isoDate(d);
}

export async function executeEveTool(name: string, args: ToolArgs): Promise<unknown> {
  const supabase = await createClient();

  if (name === "get_current_user") {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { error: "Nicht eingeloggt" };
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, full_name, email, role")
      .eq("id", user.id)
      .maybeSingle();
    return profile ?? { error: "Profil nicht gefunden" };
  }

  if (name === "list_jobs") {
    const limit = clampLimit(args.limit, 20, 50);
    const customerSearch = typeof args.customer_search === "string" ? args.customer_search.trim() : "";
    const locationSearch = typeof args.location_search === "string" ? args.location_search.trim() : "";
    // Wenn ein Filter auf customer/location aktiv ist, MUSS der Embedded-
    // Join inner-join sein (!inner) — sonst filtert PostgREST nur das
    // embedded-Feld (wird null) und der parent bleibt drin. Praktisch
    // wuerden alle jobs returned werden statt nur die mit matching customer.
    const customerSelect = customerSearch ? "customer:customers!inner(name)" : "customer:customers(name)";
    const locationSelect = locationSearch ? "location:locations!inner(name)" : "location:locations(name)";
    let q = supabase
      .from("jobs")
      .select(`job_number, title, status, start_date, end_date, invoiced_at, invoice_number, ${customerSelect}, ${locationSelect}`)
      .neq("is_deleted", true);

    const status = typeof args.status === "string" ? args.status : "";
    if (status === "alle") {
      // kein status-filter
    } else if (status) {
      const list = status.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length > 0) q = q.in("status", list);
    } else {
      q = q.not("status", "in", '("abgeschlossen","storniert")');
    }

    if (customerSearch) q = q.ilike("customer.name", `%${customerSearch}%`);
    if (locationSearch) q = q.ilike("location.name", `%${locationSearch}%`);
    if (typeof args.from_date === "string") q = q.gte("start_date", args.from_date);
    if (typeof args.to_date === "string") q = q.lte("start_date", args.to_date);
    if (args.invoiced === "yes") q = q.not("invoiced_at", "is", null);
    if (args.invoiced === "no") q = q.is("invoiced_at", null);

    q = q.order("start_date", { ascending: true, nullsFirst: false }).limit(limit);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { count: data?.length ?? 0, jobs: data ?? [] };
  }

  if (name === "stempel_summary") {
    const fromDate = typeof args.from_date === "string" ? args.from_date : startOfWeek();
    const toDate = typeof args.to_date === "string" ? args.to_date : isoDate(new Date());
    const userSearch = typeof args.user_search === "string" ? args.user_search.trim() : "";
    const scope = userSearch ? "user" : (args.scope === "all" ? "all" : "me");

    // Aufrufer holen — fuer Permission-Check bei cross-user-Queries.
    const { data: { user: caller } } = await supabase.auth.getUser();
    if (!caller) return { error: "Nicht eingeloggt" };

    // Wenn nach bestimmtem User gefiltert wird: erst die User-IDs aus
    // profiles holen, dann time_entries-Filter. Cleaner als embedded-
    // filter weil profiles!inner mit ilike in einer Query manchmal flaky.
    let userIds: string[] | null = null;
    if (scope === "user") {
      const { data: hits } = await supabase
        .from("profiles")
        .select("id, full_name")
        .or(`full_name.ilike.%${userSearch}%,email.ilike.%${userSearch}%`)
        .limit(5);
      const matched = (hits ?? []) as { id: string; full_name: string | null }[];
      userIds = matched.map((h) => h.id);
      if (userIds.length === 0) return { error: `Kein User gefunden fuer '${userSearch}'`, hint: "Vollstaendigen Namen oder Email probieren" };

      // Cross-user-Query: pruefe Caller's Rolle. RLS filtert die time_entries
      // sowieso (Nicht-Admins sehen nur eigene), aber dann waere die Antwort
      // irrefuehrend "0 Sessions" ohne klar zu sagen "darfst du nicht sehen".
      const isCallerAdmin = await (async () => {
        const { data: cp } = await supabase.from("profiles").select("role").eq("id", caller.id).maybeSingle();
        return cp?.role === "admin";
      })();
      const queryingSelf = userIds.length === 1 && userIds[0] === caller.id;
      if (!isCallerAdmin && !queryingSelf) {
        return {
          error: "Keine Berechtigung",
          hint: `Du kannst nur deine eigenen Stempelzeiten abfragen. Fuer Daten von ${matched.map(m => m.full_name).join(", ")} braucht's Admin-Rolle.`,
        };
      }
    } else if (scope === "all") {
      const { data: cp } = await supabase.from("profiles").select("role").eq("id", caller.id).maybeSingle();
      if (cp?.role !== "admin") {
        return { error: "Keine Berechtigung", hint: "scope='all' ist nur fuer Admins. Frag stattdessen mit scope='me' nach deinen eigenen Stempelzeiten." };
      }
    }

    // Fuer job_number-Filter: !inner damit der filter wirklich greift
    const jobSelect = typeof args.job_number === "number" ? "job:jobs!inner(job_number, title)" : "job:jobs(job_number, title)";
    let q = supabase
      .from("time_entries")
      .select(`user_id, clock_in, clock_out, ${jobSelect}, profile:profiles!time_entries_profile_id_fkey(full_name)`)
      .gte("clock_in", `${fromDate}T00:00:00`)
      .lte("clock_in", `${toDate}T23:59:59`)
      .not("clock_out", "is", null);

    if (scope === "me") {
      q = q.eq("user_id", caller.id);
    } else if (scope === "user" && userIds) {
      q = q.in("user_id", userIds);
    }
    if (typeof args.job_number === "number") q = q.eq("job.job_number", args.job_number);

    const { data, error } = await q;
    if (error) return { error: error.message };

    type Row = { user_id: string; clock_in: string; clock_out: string | null; job: { job_number: number; title: string } | null; profile: { full_name: string } | null };
    const rows = (data ?? []) as unknown as Row[];

    const byUser = new Map<string, { name: string; minutes: number; sessions: number }>();
    const byJob = new Map<number, { title: string; minutes: number; sessions: number }>();
    let total = 0;
    let totalSessions = 0;

    for (const r of rows) {
      if (!r.clock_out) continue;
      const min = Math.max(0, Math.round((new Date(r.clock_out).getTime() - new Date(r.clock_in).getTime()) / 60000));
      total += min;
      totalSessions++;
      const userName = r.profile?.full_name ?? "?";
      const u = byUser.get(r.user_id) ?? { name: userName, minutes: 0, sessions: 0 };
      u.minutes += min;
      u.sessions++;
      byUser.set(r.user_id, u);
      if (r.job?.job_number) {
        const j = byJob.get(r.job.job_number) ?? { title: r.job.title, minutes: 0, sessions: 0 };
        j.minutes += min;
        j.sessions++;
        byJob.set(r.job.job_number, j);
      }
    }

    return {
      from: fromDate,
      to: toDate,
      total_sessions: totalSessions,
      total_minutes: total,
      total_hours: Math.round(total / 60 * 10) / 10,
      by_user: Array.from(byUser.values()).sort((a, b) => b.minutes - a.minutes),
      by_job: Array.from(byJob.entries()).map(([n, v]) => ({ job_number: n, title: v.title, minutes: v.minutes, sessions: v.sessions })).sort((a, b) => b.minutes - a.minutes),
    };
  }

  if (name === "list_tickets") {
    const limit = clampLimit(args.limit, 20, 50);
    let q = supabase
      .from("tickets")
      .select("ticket_number, title, type, status, created_at, assigned_to, created_by")
      .order("created_at", { ascending: false })
      .limit(limit);

    const status = typeof args.status === "string" ? args.status : "offen";
    if (status !== "alle") q = q.eq("status", status);
    if (typeof args.type === "string") q = q.eq("type", args.type);
    if (args.only_mine === true) {
      const { data: { user } } = await supabase.auth.getUser();
      // "Meine" = ich hab erstellt ODER bin zugeweisen; tickets sind oft
      // unassigned (z.B. Stempel-Aenderung an alle Admins).
      if (user) q = q.or(`assigned_to.eq.${user.id},created_by.eq.${user.id}`);
    }

    const { data, error } = await q;
    if (error) return { error: error.message };
    return { count: data?.length ?? 0, tickets: data ?? [] };
  }

  if (name === "search_customers") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { error: "query fehlt" };
    const limit = clampLimit(args.limit, 10, 30);
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, email, phone, address_city, bexio_nr")
      .ilike("name", `%${query}%`)
      .is("archived_at", null)
      .limit(limit);
    if (error) return { error: error.message };
    return { count: data?.length ?? 0, customers: data ?? [] };
  }

  if (name === "list_open_todos") {
    const limit = clampLimit(args.limit, 20, 50);
    let q = supabase
      .from("todos")
      .select("title, description, due_date, priority, assigned_to, profile:profiles!todos_assigned_to_fkey(full_name)")
      .eq("status", "offen")
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(limit);

    if (args.only_mine !== false) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) q = q.eq("assigned_to", user.id);
    }

    const { data, error } = await q;
    if (error) return { error: error.message };
    return { count: data?.length ?? 0, todos: data ?? [] };
  }

  return { error: `Unbekanntes Tool: ${name}` };
}
