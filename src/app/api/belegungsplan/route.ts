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

    const [allRes, visibleRes] = await Promise.all([
      admin
        .from("jobs")
        .select("id, job_number, title, status, was_anfrage, start_date, end_date, location_id, customer:customers(name)")
        .neq("is_deleted", true)
        .not("location_id", "is", null)
        .or(`start_date.gte.${start},end_date.gte.${start}`)
        .lt("start_date", end),
      // Identische Query mit User-Session — RLS filtert auf "der User darf
      // das sehen". Wir brauchen nur die ids.
      userClient
        .from("jobs")
        .select("id")
        .neq("is_deleted", true)
        .not("location_id", "is", null)
        .or(`start_date.gte.${start},end_date.gte.${start}`)
        .lt("start_date", end),
    ]);

    if (allRes.error) {
      logError("api.belegungsplan.admin", allRes.error);
      return NextResponse.json({ error: allRes.error.message }, { status: 500 });
    }

    const visibleIds = new Set(((visibleRes.data ?? []) as { id: string }[]).map((r) => r.id));
    const jobs = (allRes.data ?? []) as Job[];

    const bookings = jobs.map((j) => {
      const visible = visibleIds.has(j.id);
      const cust = Array.isArray(j.customer) ? j.customer[0] : j.customer;
      // Maskiert: keine Inhalte ausser Datum/Location/Status (= "irgendwas
      // belegt diese Cell").
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
      };
    });

    return NextResponse.json({ bookings });
  } catch (e) {
    logError("api.belegungsplan", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unbekannter Fehler" }, { status: 500 });
  }
}
