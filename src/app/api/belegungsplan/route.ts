import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logError } from "@/lib/log";

/**
 * GET /api/belegungsplan?start=ISO&end=ISO
 *
 * Belegungsplan-Daten fuer alle Mitarbeiter sichtbar — aber Auftrags-
 * Details (Titel, Kunde, INT-Nr) nur wenn der anfragende User dem Auftrag
 * zugeteilt ist. Sonst kommt das Booking als 'visible: false' zurueck und
 * die View rendert "Belegt — nicht zugeteilt".
 *
 * Implementation: zwei parallele Queries
 *  1. Service-Role: ALLE jobs in der Range (RLS-Bypass) — fuer die rohe
 *     Belegungs-Visualisierung
 *  2. User-Session: nur jobs die der User sehen darf (RLS aktiv) — gibt
 *     uns die Liste der ids fuer das visible-Flag
 *
 * So muessen wir nicht pro Job eine separate Permission-Check-RPC rufen.
 */

interface Job {
  id: string;
  job_number: number | null;
  title: string;
  status: string;
  was_anfrage: boolean | null;
  start_date: string | null;
  end_date: string | null;
  location_id: string | null;
  created_by: string | null;
  customer: { name: string } | { name: string }[] | null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireUser();
    if (auth.error) return auth.error;

    const url = new URL(request.url);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (!start || !end) {
      return NextResponse.json({ error: "start + end query params noetig" }, { status: 400 });
    }

    const admin = createAdminClient();
    const userClient = await createClient();

    // Partner-Rolle: server-seitig auf eigene Location einschraenken — der
    // Partner sieht eh nur jobs an seiner Location (jobs_select RLS), aber
    // die Service-Role-Query nimmt sonst alle Locations und schickt mehr
    // Daten als noetig durchs Netz.
    const { data: callerProfile } = await admin
      .from("profiles")
      .select("role, partner_location_id")
      .eq("id", auth.user.id)
      .maybeSingle();
    const partnerLocationId =
      callerProfile?.role === "partner" ? callerProfile.partner_location_id : null;

    // Team-Member-Set: ALLE Partner-User die zum gleichen partner_location_id
    // gehoeren — fuer das is_own-Flag. Vorher hat is_own nur auf created_by
    // == eigene User-ID geprueft; Konsequenz war dass Anfragen die ein
    // anderer Partner-Kollege am gleichen Standort angelegt hat als "fremd"
    // angezeigt wurden und ggf. komplett verschwanden (siehe gleiche Logik
    // in /partner/anfragen). Partner-Sicht ist Location-shared, nicht
    // user-shared.
    const teamMemberIds = new Set<string>([auth.user.id]);
    if (partnerLocationId) {
      const { data: team } = await admin
        .from("profiles")
        .select("id")
        .eq("role", "partner")
        .eq("partner_location_id", partnerLocationId);
      for (const t of (team ?? []) as { id: string }[]) teamMemberIds.add(t.id);
    }

    // Range-Filter:
    //   start_date < end          (Booking beginnt vor Range-Ende)
    //   AND (end_date >= start OR end_date IS NULL AND start_date >= start)
    //     (Booking endet im oder nach Range-Anfang — Mehrtages-Events die
    //      vor Range-Anfang begannen aber noch laufen, bleiben drin)
    // Frueher: or(start.gte || end.gte) AND lt(start, end) — das hat
    // mehrtaegige Bookings rausgefiltert die mit start_date < range_start
    // aber end_date > range_start. Bug Audit #7.
    const rangeFilter = `and(start_date.lt.${end},or(end_date.gte.${start},and(end_date.is.null,start_date.gte.${start})))`;

    let adminQuery = admin
      .from("jobs")
      .select("id, job_number, title, status, was_anfrage, start_date, end_date, location_id, created_by, customer:customers(name)")
      .neq("is_deleted", true)
      .not("location_id", "is", null)
      .or(rangeFilter);
    let userQuery = userClient
      .from("jobs")
      .select("id")
      .neq("is_deleted", true)
      .not("location_id", "is", null)
      .or(rangeFilter);
    if (partnerLocationId) {
      adminQuery = adminQuery.eq("location_id", partnerLocationId);
      userQuery = userQuery.eq("location_id", partnerLocationId);
    }

    const [allRes, visibleRes] = await Promise.all([adminQuery, userQuery]);

    if (allRes.error) {
      logError("api.belegungsplan.admin", allRes.error);
      return NextResponse.json({ error: allRes.error.message }, { status: 500 });
    }

    const visibleIds = new Set(((visibleRes.data ?? []) as { id: string }[]).map((r) => r.id));
    const jobs = (allRes.data ?? []) as Job[];

    const bookings = jobs.map((j) => {
      const visible = visibleIds.has(j.id);
      // Team-shared: jeder Job dessen Ersteller im Partner-Team derselben
      // Location ist gilt fuer alle Partner-User dort als "eigen". Fallback
      // fuer Eventline-User: nur strikt eigene (created_by == self).
      const isOwn = teamMemberIds.has(j.created_by ?? "");
      const cust = Array.isArray(j.customer) ? j.customer[0] : j.customer;
      // Maskiert: keine Inhalte ausser Datum/Location/Status (= "irgendwas
      // belegt diese Cell"). is_own ist immer als boolean dabei — die
      // Partner-View differenziert damit zwischen "meine Anfrage" und
      // "EVENTLINE-Eintrag an meiner Location" (beide visible=true via
      // location-RLS, aber unterschiedliche Farbe).
      return visible ? {
        id: j.id,
        job_number: j.job_number,
        title: j.title,
        status: j.status,
        was_anfrage: j.was_anfrage,
        start_date: j.start_date,
        end_date: j.end_date,
        location_id: j.location_id,
        customer_name: cust?.name ?? null,
        visible: true,
        is_own: isOwn,
      } : {
        id: j.id,
        job_number: null,
        title: null,
        status: j.status,
        was_anfrage: j.was_anfrage,
        start_date: j.start_date,
        end_date: j.end_date,
        location_id: j.location_id,
        customer_name: null,
        visible: false,
        is_own: isOwn,
      };
    });

    return NextResponse.json({ bookings });
  } catch (e) {
    logError("api.belegungsplan", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unbekannter Fehler" }, { status: 500 });
  }
}
