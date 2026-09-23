import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";

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
//   - vertrieb_contacts (Leads): firma, ansprechperson
//   - customers (Kunden): name, email
//   - locations (Standorte): name, address_city
//   - rooms (Raeume): name, address_city
//   - tickets: title, ticket_number (T-XXX)
//   - todos: title
//   - profiles (Mitarbeiter): full_name, email
//
// INT-Overflow-Falle: parseInt fuer numerische Suche nur wenn Zahl in
// int32-Range. Sonst wuerde Postgres den eq-Vergleich mit einem
// out-of-range Integer ablehnen.

// Postgres int4 max: 2^31 - 1
const INT32_MAX = 2147483647;

export interface SearchResult {
  type:
    | "auftrag"
    | "lead"
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
  const qNumMatch = q.match(/^(?:INT-|T-|PROJ-)?(\d+)$/i);
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
    leadsRes,
    kundenRes,
    standorteRes,
    raeumeRes,
    ticketsRes,
    todosRes,
    profilesRes,
  ] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, job_number, title, status, customer:customers(name)")
      .or(jobsFilter)
      .order("job_number", { ascending: false, nullsFirst: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("vertrieb_contacts")
      .select("id, firma, ansprechperson, status")
      .or(`firma.ilike.${qLike},ansprechperson.ilike.${qLike}`)
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
      .select("id, title, status")
      .ilike("title", `%${q}%`)
      .order("created_at", { ascending: false })
      .limit(LIMIT_PER_TYPE),
    supabase
      .from("profiles")
      .select("id, full_name, email, role")
      .or(`full_name.ilike.${qLike},email.ilike.${qLike}`)
      .not("role", "in", PORTAL_ROLLEN_IN)
      .order("full_name")
      .limit(LIMIT_PER_TYPE),
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

  if (!leadsRes.error && leadsRes.data) {
    for (const l of leadsRes.data as Array<{
      id: string;
      firma: string;
      ansprechperson: string | null;
    }>) {
      results.push({
        type: "lead",
        id: l.id,
        label: l.firma,
        sublabel: l.ansprechperson ?? undefined,
        href: `/vertrieb?lead=${l.id}`,
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
        sublabel: s.address_city ?? undefined,
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
        sublabel: r.address_city ?? undefined,
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
    }>) {
      results.push({
        type: "todo",
        id: t.id,
        label: t.title,
        sublabel: t.status === "erledigt" ? "erledigt" : "offen",
        href: `/todos`,
      });
    }
  }

  if (!profilesRes.error && profilesRes.data) {
    for (const p of profilesRes.data as Array<{
      id: string;
      full_name: string;
      email: string | null;
      role: string;
    }>) {
      results.push({
        type: "mitarbeiter",
        id: p.id,
        label: p.full_name,
        sublabel: p.email ?? undefined,
        href: `/einstellungen`,
      });
    }
  }

  return NextResponse.json({ results });
}
