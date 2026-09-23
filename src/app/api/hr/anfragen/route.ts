import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { ZRH_TZ } from "@/lib/swiss-time";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";

/**
 * GET /api/hr/anfragen — Admin-only Aggregat fuer den HR-„Anfragen"-Tab.
 *
 * Liefert drei Aktions-Listen (ungenehmigte Ferien, Stempel-Aenderungs-
 * Tickets, andere offene Tickets) sowie eine kompakte Mitarbeiter-Ampel
 * (aktive Techniker mit Monats-Stunden, naechstem Einsatz, aktuellem
 * Stempel/Abwesenheits-Status).
 *
 * Alle Queries laufen parallel; nichts wird pro MA in einer Schleife
 * gequeried — sonst skaliert die Route ab 30+ MA nicht mehr.
 */

interface ProfileRow { id: string; full_name: string }
interface TimeOffRow {
  id: string; user_id: string; type: string;
  start_date: string; end_date: string; created_at: string;
  note: string | null;
}
interface TicketRow {
  id: string; ticket_number: number; type: string; title: string;
  created_at: string; created_by: string; assigned_to: string | null;
}
interface TimeEntryRow {
  user_id: string; clock_in: string; clock_out: string | null;
}
interface AppointmentRow {
  assigned_to: string; start_time: string;
  job: { id: string; job_number: number | null; title: string | null } | null;
}
interface AbsenceRow {
  user_id: string; type: string; end_date: string;
}

/**
 * Liest Y/M/D/H/M/S eines Instants im Europe/Zurich-Kalender via
 * Intl.DateTimeFormat.formatToParts — locale-unabhaengig und DST-safe
 * (im Gegensatz zu `new Date(d.toLocaleString('en-US', {timeZone}))`,
 * das je nach ICU-Version anders parst und bei DST-Wechseln kippen kann).
 */
function zurichPartsAt(instantMs: number): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZRH_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instantMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const h = g("hour");
  return { y: g("year"), m: g("month"), d: g("day"), h: h === 24 ? 0 : h, mi: g("minute"), s: g("second") };
}

/** UTC-Millisekunden fuer einen Zurich-Wall-Clock-Zeitpunkt (y-m-d h:mi:s local).
 *  Zwei-Pass-Offset: erst als UTC interpretieren, dann Offset per Zurich-Formatierung
 *  ableiten. DST-korrekt, keine externe Library noetig. */
function zurichWallToUtcMs(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const p = zurichPartsAt(guess);
  const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  const offset = seen - guess;
  return guess - offset;
}

export async function GET() {
  // Gleiche Rechte wie das UI-Gate des HR-Anfragen-Tabs (hr/page.tsx):
  // eines der drei Modul-Rechte genuegt.
  const auth = await requireAnyPermission(["ferien:approve", "tickets:manage", "stempelzeiten:see-all"]);
  if (auth.error) return auth.error;
  // dev-mode: effective user
  const adminUserId = auth.effectiveUserId;

  try {
    const admin = createAdminClient();

    // Monatsgrenzen (Europe/Zurich Kalender-Monat) — als ISO fuer die
    // Postgres-Vergleiche gegen clock_in (timestamptz).
    const now = new Date();
    const zp = zurichPartsAt(now.getTime());
    const monthStartIso = new Date(zurichWallToUtcMs(zp.y, zp.m, 1)).toISOString();
    const todayIso = `${zp.y}-${String(zp.m).padStart(2, "0")}-${String(zp.d).padStart(2, "0")}`;
    const nowIso = now.toISOString();

    const [
      profilesRes,
      ferienRes,
      stempelTicketsRes,
      andereTicketsRes,
      monthEntriesRes,
      activeStampsRes,
      appointmentsRes,
      absencesRes,
    ] = await Promise.all([
      // Aktive interne MA fuer die Ampel — Partner sind extern (eigenes
      // Portal, kein HR-Handling), deshalb ausgeschlossen. Alle anderen
      // Rollen (Admin/Team-Leiter/Techniker/Projekt-Leiter/Vertrieb) sind
      // "intern" und gehoeren in die HR-Sicht.
      admin
        .from("profiles")
        .select("id, full_name")
        .eq("is_active", true)
        .not("role", "in", PORTAL_ROLLEN_IN)
        .order("full_name", { ascending: true }),
      // Ferienantraege — noch nicht entschieden.
      admin
        .from("time_off")
        .select("id, user_id, type, start_date, end_date, created_at, note")
        .eq("status", "beantragt")
        .order("created_at", { ascending: false }),
      // Stempel-Aenderungs-Tickets (offen).
      admin
        .from("tickets")
        .select("id, ticket_number, type, title, created_at, created_by, assigned_to")
        .eq("type", "stempel_aenderung")
        .eq("status", "offen")
        .order("created_at", { ascending: false }),
      // Andere offene Tickets (IT/Beleg/Material) die diesem Admin
      // zugewiesen sind ODER noch niemandem.
      admin
        .from("tickets")
        .select("id, ticket_number, type, title, created_at, created_by, assigned_to")
        .in("type", ["it", "beleg", "material"])
        .eq("status", "offen")
        .or(`assigned_to.eq.${adminUserId},assigned_to.is.null`)
        .order("created_at", { ascending: false }),
      // Alle time_entries im laufenden Monat — clientseitig pro user_id
      // zu Stunden aufsummiert.
      admin
        .from("time_entries")
        .select("user_id, clock_in, clock_out")
        .gte("clock_in", monthStartIso),
      // Alle offenen Stempel (clock_out IS NULL) — fuer „aktuell eingestempelt".
      admin
        .from("time_entries")
        .select("user_id, clock_in, clock_out")
        .is("clock_out", null),
      // Kommende Termine — pro MA nehmen wir clientseitig den ersten.
      admin
        .from("job_appointments")
        .select("assigned_to, start_time, job:jobs(id, job_number, title)")
        .not("assigned_to", "is", null)
        .gte("start_time", nowIso)
        .order("start_time", { ascending: true }),
      // Laufende Abwesenheiten (genehmigt) fuer heute.
      admin
        .from("time_off")
        .select("user_id, type, end_date")
        .eq("status", "genehmigt")
        .lte("start_date", todayIso)
        .gte("end_date", todayIso),
    ]);

    // Profile fuer Ticket-/Ferien-Anzeige. Wir laden sie einmal separat
    // aus den beteiligten User-IDs (statt Foreign-Join pro Query).
    const involvedUserIds = new Set<string>();
    const profiles = (profilesRes.data as ProfileRow[] | null) ?? [];
    for (const p of profiles) involvedUserIds.add(p.id);
    const ferienAntraege = (ferienRes.data as TimeOffRow[] | null) ?? [];
    for (const f of ferienAntraege) involvedUserIds.add(f.user_id);
    const stempelTickets = (stempelTicketsRes.data as TicketRow[] | null) ?? [];
    for (const t of stempelTickets) involvedUserIds.add(t.created_by);
    const andereTickets = (andereTicketsRes.data as TicketRow[] | null) ?? [];
    for (const t of andereTickets) involvedUserIds.add(t.created_by);

    const nameById = new Map<string, string>();
    if (involvedUserIds.size > 0) {
      const { data: allProfiles } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", Array.from(involvedUserIds));
      for (const p of (allProfiles as ProfileRow[] | null) ?? []) {
        nameById.set(p.id, p.full_name);
      }
    }

    // --- Ampel-Aggregation ---
    const monthEntries = (monthEntriesRes.data as TimeEntryRow[] | null) ?? [];
    const nowMs = Date.now();
    const monthMinutesByUser = new Map<string, number>();
    for (const e of monthEntries) {
      const start = new Date(e.clock_in).getTime();
      const end = e.clock_out ? new Date(e.clock_out).getTime() : nowMs;
      if (end > start) {
        const mins = Math.floor((end - start) / 60000);
        monthMinutesByUser.set(e.user_id, (monthMinutesByUser.get(e.user_id) ?? 0) + mins);
      }
    }

    const activeStamps = (activeStampsRes.data as TimeEntryRow[] | null) ?? [];
    const activeStampByUser = new Map<string, string>();
    for (const s of activeStamps) {
      // Erster (frueheste) offene Stempel pro User — falls je > 1.
      const prev = activeStampByUser.get(s.user_id);
      if (!prev || s.clock_in < prev) activeStampByUser.set(s.user_id, s.clock_in);
    }

    const appointments = (appointmentsRes.data as unknown as AppointmentRow[] | null) ?? [];
    const nextShiftByUser = new Map<string, AppointmentRow>();
    for (const a of appointments) {
      if (!a.assigned_to) continue;
      if (!nextShiftByUser.has(a.assigned_to)) {
        nextShiftByUser.set(a.assigned_to, a);
      }
    }

    const absences = (absencesRes.data as AbsenceRow[] | null) ?? [];
    const absenceByUser = new Map<string, AbsenceRow>();
    for (const a of absences) absenceByUser.set(a.user_id, a);

    const mitarbeiter = profiles.map((p) => {
      const activeSince = activeStampByUser.get(p.id) ?? null;
      const next = nextShiftByUser.get(p.id) ?? null;
      const absence = absenceByUser.get(p.id) ?? null;
      return {
        id: p.id,
        full_name: p.full_name,
        month_minutes: monthMinutesByUser.get(p.id) ?? 0,
        next_shift: next && next.job
          ? {
              start_time: next.start_time,
              job_id: next.job.id,
              job_number: next.job.job_number,
              job_title: next.job.title,
            }
          : null,
        is_active_stamped: !!activeSince,
        active_since_iso: activeSince,
        current_absence: absence
          ? { type: absence.type, end_date: absence.end_date }
          : null,
      };
    });

    return NextResponse.json({
      success: true,
      ferienAntraege: ferienAntraege.map((f) => ({
        id: f.id,
        user_id: f.user_id,
        user_name: nameById.get(f.user_id) ?? "Unbekannt",
        type: f.type,
        start_date: f.start_date,
        end_date: f.end_date,
        created_at: f.created_at,
        note: f.note,
      })),
      stempelAntraege: stempelTickets.map((t) => ({
        id: t.id,
        ticket_number: t.ticket_number,
        title: t.title,
        created_at: t.created_at,
        user_id: t.created_by,
        user_name: nameById.get(t.created_by) ?? "Unbekannt",
      })),
      andereTickets: andereTickets.map((t) => ({
        id: t.id,
        ticket_number: t.ticket_number,
        type: t.type,
        title: t.title,
        created_at: t.created_at,
        user_id: t.created_by,
        user_name: nameById.get(t.created_by) ?? "Unbekannt",
      })),
      mitarbeiter,
    });
  } catch (err) {
    logError("api.hr.anfragen.GET", err);
    return NextResponse.json(
      { success: false, error: "Anfragen konnten nicht geladen werden" },
      { status: 500 },
    );
  }
}
