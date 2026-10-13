import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { NUMMER_SUCHE_RE } from "@/lib/nummern-format";

// GET /api/search?q=...
//
// Globale Suche fuer die Cmd-K-Command-Palette. Orchestriert parallele
// Queries ueber alle Kern-Entitaeten. Bewusst mit dem User-Client
// (RLS aktiv) — jeder Nutzer sieht nur was er sowieso sehen darf.
//
// Ergebnisse:
//   [{ type, id, label, sublabel, href }]
//
// Suchfelder pro Typ:
//   - jobs (Auftraege): title, job_number (INT-XXXXX)
//     + Kundenname (via customer)
//   - akquise_locations (Akquise-Kandidaten): name, ort
//   - customers (Kunden): name, email
//   - locations (Locations vom Typ Verwaltung): name, address_city
//   - rooms (Locations vom Typ Raum): name, address_city
//     → in der Palette gemeinsam unter «Locations», Typ in der Unterzeile
//   - tickets: title, ticket_number (T-XXX)
//   - todos: title
//   - profiles (Mitarbeiter): full_name, email
//
// Geloeschte Datensaetze (Papierkorb/soft delete) sind ueberall dort
// ausgeschlossen, wo auch die zugehoerige Liste sie nie zeigt:
//   - jobs: is_deleted (gleicher Nullguard wie die Auftraege-Liste)
//   - todos: deleted_at (wie src/lib/todos-query.ts)
// Archivierte/erledigte/deaktivierte bleiben bewusst drin (CLAUDE.md §15) —
// customers/locations/tickets (archived_at), locations.is_active (Spiegel
// des Archivs) und profiles.is_active (Team-Liste zeigt Deaktivierte).
// customers, rooms, tickets und akquise_locations werden hart geloescht.
//
// INT-Overflow-Falle: parseInt fuer numerische Suche nur wenn Zahl in
// int32-Range. Sonst wuerde Postgres den eq-Vergleich mit einem
// out-of-range Integer ablehnen.

// Postgres int4 max: 2^31 - 1
const INT32_MAX = 2147483647;

export interface SearchResult {
  type:
    | "auftrag"
    | "akquise"
    | "kunde"
    | "standort"
    | "raum"
    | "ticket"
    | "todo"
    | "mitarbeiter";
  id: string;
  label: string;
  sublabel?: string;
  href: string;
}

const LIMIT_PER_TYPE = 5;

/**
 * Escaped einen Such-String fuer PostgREST `.or(...)`-Filter. Kommas,
 * Klammern, Doppelpunkte und Sternchen wuerden sonst das Filter-Grammar
 * zerbrechen. */
function escapeForOr(s: string): string {
  return s.replace(/[,()*\\]/g, "\\$&");
}

/**
 * Link auf die Todo-Seite, der den Treffer dort auch sichtbar macht: sie
 * startet sonst mit "Für mich" + nur offenen Todos (bzw. dem Stand aus dem
 * localStorage) — ein fremdes oder erledigtes Todo waere dann unsichtbar.
 * Die Seite liest scope/completed/q beim Laden aus der URL (URL schlaegt
 * localStorage). Scope wie in todos-query.ts: mir zugewiesen → mine, von
 * mir an andere delegiert → delegated, sonst all (nur mit todos:see-all
 * ueberhaupt per RLS sichtbar). Als q dient das laengste Titel-Stueck ohne
 * Zeichen, die der unescapte `.or(...)`-Filter der Todo-Seite nicht
 * vertraegt — so trifft die Suche dort sicher genau diesen Titel. */
function todoHref(
  t: { title: string; status: string; assigned_to: string | null; created_by: string | null },
  meId: string | null,
): string {
  const scope =
    meId && t.assigned_to === meId ? "mine"
    : meId && t.created_by === meId && t.assigned_to !== null ? "delegated"
    : "all";
  const { title, status } = t;
  const sp = new URLSearchParams({ scope });
  if (status === "erledigt") sp.set("completed", "1");
  const term = title
    .split(/[,()*\\"]/)
    .map((s) => s.trim())
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  if (term) sp.set("q", term);
  return `/todos?${sp.toString()}`;
}

export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const raw = url.searchParams.get("q")?.trim() ?? "";
  if (raw.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const supabase = await createClient();
  const q = raw;
  const qLike = `%${escapeForOr(q)}%`;
  const qNumMatch = q.match(NUMMER_SUCHE_RE);
  const asInt = qNumMatch ? parseInt(qNumMatch[1], 10) : null;
  const asIntSafe = asInt != null && asInt <= INT32_MAX ? asInt : null;

  // Wir bauen die Filter pro Entitaet und feuern alle parallel. Fehler
  // in einer Query soll nicht die ganze Suche kippen — deshalb pro
  // Ergebnis catch + Fallback auf leere Liste.
  const jobsFilter = asIntSafe != null
    ? `title.ilike.${qLike},job_number.eq.${asIntSafe}`
    : `title.ilike.${qLike}`;

  const ticketsFilter = asIntSafe != null
    ? `title.ilike.${qLike},ticket_number.eq.${asIntSafe}`
    : `title.ilike.${qLike}`;

  const [
    jobsRes,
    akquiseRes,
    kundenRes,
    standorteRes,
    raeumeRes,
    ticketsRes,
    todosRes,
    profilesRes,
    meRes,
  ] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, job_number, title, status, customer:customers(name)")
      .or(jobsFilter)
      .or("is_deleted.is.null,is_deleted.eq.false")
      .order("job_number", { ascending: false, nullsFirst: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("akquise_locations")
      .select("id, name, ort, score")
      .or(`name.ilike.${qLike},ort.ilike.${qLike}`)
      // Beste Kandidaten zuerst — die Suche soll den relevantesten Treffer
      // oben zeigen, nicht den zufaellig zuerst erfassten.
      .order("score", { ascending: false, nullsFirst: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("customers")
      .select("id, name, email, type")
      .or(`name.ilike.${qLike},email.ilike.${qLike}`)
      .order("name")
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("locations")
      .select("id, name, address_city")
      .or(`name.ilike.${qLike},address_city.ilike.${qLike}`)
      .order("name")
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("rooms")
      .select("id, name, address_city")
      .or(`name.ilike.${qLike},address_city.ilike.${qLike}`)
      .order("name")
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("tickets")
      .select("id, ticket_number, title, type, status")
      .or(ticketsFilter)
      .order("ticket_number", { ascending: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("todos")
      .select("id, title, status, assigned_to, created_by")
      .ilike("title", `%${q}%`)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("profiles")
      .select("id, full_name, email, role")
      .or(`full_name.ilike.${qLike},email.ilike.${qLike}`)
      .not("role", "in", PORTAL_ROLLEN_IN)
      .order("full_name")
      .limit(LIMIT_PER_TYPE),
    // Rolle der (ggf. per «Ansicht als» simulierten) Person — Mitarbeiter-
    // Treffer fuehren auf Einstellungen › Mitarbeiter, das nur Admins sehen.
    supabase
      .from("profiles")
      .select("role")
      .eq("id", auth.effectiveUserId)
      .maybeSingle(),
  ]);

  const results: SearchResult[] = [];

  // Jobs → alle als Auftrag. Vermietentwurf-Pipeline (status='anfrage')
  // ist 2026-09 weggefallen; legacy Records mit status='anfrage' werden
  // ausgeblendet — sie haben keine Detail-Seite mehr.
  if (!jobsRes.error && jobsRes.data) {
    const auftraege: SearchResult[] = [];
    for (const j of jobsRes.data as Array<{
      id: string;
      job_number: number | null;
      title: string;
      status: string;
      customer: { name: string } | { name: string }[] | null;
    }>) {
      if (j.status === "anfrage") continue;
      if (auftraege.length >= LIMIT_PER_TYPE) continue;
      const cust = Array.isArray(j.customer) ? j.customer[0] : j.customer;
      const nrLabel = j.job_number ? `INT-${j.job_number}` : "INT-…";
      auftraege.push({
        type: "auftrag",
        id: j.id,
        label: `${nrLabel} · ${j.title}`,
        sublabel: cust?.name ?? undefined,
        href: `/auftraege/${j.id}`,
      });
    }
    results.push(...auftraege);
  }

  if (!akquiseRes.error && akquiseRes.data) {
    for (const l of akquiseRes.data as Array<{
      id: string;
      name: string;
      ort: string | null;
      score: number | null;
    }>) {
      results.push({
        type: "akquise",
        id: l.id,
        label: l.name,
        sublabel: [l.ort, l.score !== null ? `Score ${l.score}` : null]
          .filter(Boolean).join(" · ") || undefined,
        href: `/vertrieb?id=${l.id}`,
      });
    }
  }

  if (!kundenRes.error && kundenRes.data) {
    for (const c of kundenRes.data as Array<{
      id: string;
      name: string;
      email: string | null;
    }>) {
      results.push({
        type: "kunde",
        id: c.id,
        label: c.name,
        sublabel: c.email ?? undefined,
        href: `/kunden/${c.id}`,
      });
    }
  }

  if (!standorteRes.error && standorteRes.data) {
    for (const s of standorteRes.data as Array<{
      id: string;
      name: string;
      address_city: string | null;
    }>) {
      results.push({
        type: "standort",
        id: s.id,
        label: s.name,
        sublabel: ["Verwaltung", s.address_city].filter(Boolean).join(" · "),
        href: `/standorte/${s.id}`,
      });
    }
  }

  if (!raeumeRes.error && raeumeRes.data) {
    for (const r of raeumeRes.data as Array<{
      id: string;
      name: string;
      address_city: string | null;
    }>) {
      results.push({
        type: "raum",
        id: r.id,
        label: r.name,
        sublabel: ["Raum", r.address_city].filter(Boolean).join(" · "),
        href: `/raeume/${r.id}`,
      });
    }
  }

  if (!ticketsRes.error && ticketsRes.data) {
    for (const t of ticketsRes.data as Array<{
      id: string;
      ticket_number: number;
      title: string;
      type: string;
    }>) {
      results.push({
        type: "ticket",
        id: t.id,
        label: `T-${t.ticket_number} · ${t.title}`,
        sublabel: t.type,
        href: `/tickets/${t.id}`,
      });
    }
  }

  if (!todosRes.error && todosRes.data) {
    for (const t of todosRes.data as Array<{
      id: string;
      title: string;
      status: string;
      assigned_to: string | null;
      created_by: string | null;
    }>) {
      results.push({
        type: "todo",
        id: t.id,
        label: t.title,
        sublabel: t.status === "erledigt" ? "erledigt" : "offen",
        href: todoHref(t, auth.effectiveUserId),
      });
    }
  }

  const istAdmin = (meRes.data as { role?: string } | null)?.role === "admin";
  if (istAdmin && !profilesRes.error && profilesRes.data) {
    for (const p of profilesRes.data as Array<{
      id: string;
      full_name: string;
      email: string | null;
      role: string;
    }>) {
      // Mitarbeiter-Verwaltung lebt unter Einstellungen › Mitarbeiter
      // (/einstellungen?tab=mitarbeiter) — Admin-Tab, darum Treffer nur
      // fuer Admins (Nicht-Admins saehen dort nur Integrationen).
      results.push({
        type: "mitarbeiter",
        id: p.id,
        label: p.full_name,
        sublabel: p.email ?? undefined,
        href: "/einstellungen?tab=mitarbeiter",
      });
    }
  }

  return NextResponse.json({ results });
}
