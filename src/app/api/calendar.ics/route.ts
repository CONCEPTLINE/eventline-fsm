/**
 * iCal-Feed (RFC 5545) — Aufträge + Termine als abonnierbarer Kalender.
 * Google Calendar / Apple Calendar / Outlook etc koennen via "Add by URL"
 * den Eventline-Kalender abonnieren und automatisch synchronisieren.
 *
 * Zwei Token-Typen, beide ueber dieselbe URL `?token=...`:
 *
 *  1. Firma-Token (app_settings.company_calendar_token) — gibt die
 *     Komplett-Sicht: ALLE Auftraege + Termine der Firma. Eingerichtet
 *     in Einstellungen → Integrationen, rotierbar via
 *     /api/company/rotate-calendar-token. Nicht an einen User gebunden.
 *
 *  2. User-Token (profiles.calendar_feed_token) — persoenlicher Feed.
 *     Mappt zurueck auf den User und zeigt nur was er auch in der App
 *     sieht: Auftraege in denen er Project-Lead oder via job_appointments
 *     (= Termine) dabei ist, plus Termine bei denen er assigned_to ist
 *     ODER auf einem Auftrag wo er drauf ist. Admins als User sehen alles.
 *
 * Lookup-Reihenfolge: erst Firma-Token (eine Row, schneller Hit/Miss),
 * dann User-Token. Kein 401 leakt welcher Typ einen Treffer haette.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse, type NextRequest } from "next/server";

// pro User unterschiedlicher Inhalt → kein CDN-Cache. force-dynamic
// disabled Next.js-side Page-Caching. Cache-Control 'private, max-age=600'
// wird im Response-Header gesetzt (Browser-/Calendar-App-Cache OK).
export const dynamic = "force-dynamic";

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatDate(d: Date, allDay: boolean): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (allDay) return `${y}${m}${day}`;
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return new NextResponse("Token fehlt — Link aus den Einstellungen verwenden", { status: 401 });
  }

  const supabase = createAdminClient();

  // 1) Firma-Token? Singleton-Row in app_settings. Wenn match, gibt's
  //    Komplett-Sicht ohne User-Filter (isAdmin=true, userId=null).
  const { data: companyRow } = await supabase
    .from("app_settings")
    .select("company_calendar_token")
    .eq("id", 1)
    .maybeSingle();

  let userId: string | null = null;
  let isAdmin = false;
  let calendarName = "EVENTLINE";

  if (companyRow?.company_calendar_token === token) {
    isAdmin = true;
    calendarName = "EVENTLINE — Firma";
  } else {
    // 2) User-Token? Nur aktive Profile akzeptieren — deaktivierte User
    //    sollen keinen Feed mehr bekommen.
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, role, is_active, full_name")
      .eq("calendar_feed_token", token)
      .maybeSingle();

    if (!profile || !profile.is_active) {
      return new NextResponse("Token ungueltig", { status: 401 });
    }

    userId = profile.id;
    isAdmin = profile.role === "admin";
    calendarName = `EVENTLINE — ${profile.full_name ?? "Mein Kalender"}`;
  }

  // Welche Job-IDs darf der User sehen?
  // - Admin: alle nicht-geloeschten, nicht-stornierten
  // - Mitarbeiter: alle bei denen er project_lead_id ist ODER via
  //   job_appointments (= Termine) verknuepft. job_assignments wurde
  //   mit Migration 164 entfernt; Zuweisungen leben nur noch in
  //   Terminen.
  let allowedJobIds: Set<string> | null = null;
  if (!isAdmin) {
    const [{ data: leadJobs }, { data: assignedJobs }] = await Promise.all([
      supabase.from("jobs").select("id").eq("project_lead_id", userId).neq("is_deleted", true),
      supabase.from("job_appointments").select("job_id").eq("assigned_to", userId),
    ]);
    allowedJobIds = new Set<string>();
    for (const j of leadJobs ?? []) allowedJobIds.add(j.id);
    for (const a of assignedJobs ?? []) if (a.job_id) allowedJobIds.add(a.job_id);
  }

  const { data: jobs } = await supabase
    .from("jobs")
    .select("id, job_number, title, status, start_date, end_date, customer:customers(name), location:locations(name)")
    .neq("is_deleted", true)
    .neq("status", "storniert")
    .not("start_date", "is", null);

  const filteredJobs = (jobs ?? []).filter((j) => allowedJobIds === null || allowedJobIds.has(j.id));

  const { data: appts } = await supabase
    .from("job_appointments")
    .select("id, title, start_time, end_time, assigned_to, job:jobs(id, status, job_number, title, is_deleted)")
    .not("start_time", "is", null);

  // Termine: User sieht den Termin wenn er assigned_to ist ODER der
  // zugehoerige Job in seiner allowed-Liste ist (Admin sieht alles).
  const filteredAppts = (appts ?? []).filter((a) => {
    if (isAdmin) return true;
    if (a.assigned_to === userId) return true;
    const job = Array.isArray(a.job) ? a.job[0] : a.job;
    if (!job) return false;
    return allowedJobIds!.has(job.id);
  });

  const nowStr = formatDate(new Date(), false);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Eventline FSM//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeICS(calendarName)}`,
    "X-WR-TIMEZONE:Europe/Zurich",
  ];

  for (const j of filteredJobs) {
    if (!j.start_date) continue;
    const start = new Date(j.start_date);
    const end = new Date(j.end_date ?? j.start_date);
    end.setUTCDate(end.getUTCDate() + 1);
    const cust = Array.isArray(j.customer) ? j.customer[0] : j.customer;
    const loc = Array.isArray(j.location) ? j.location[0] : j.location;
    const summary = j.job_number ? `INT-${j.job_number} | ${j.title}` : j.title;
    const description = [
      cust?.name && `Kunde: ${cust.name}`,
      loc?.name && `Standort: ${loc.name}`,
      `Status: ${j.status}`,
    ].filter(Boolean).join("\n");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:job-${j.id}@eventline-basel.com`);
    lines.push(`DTSTAMP:${nowStr}`);
    lines.push(`DTSTART;VALUE=DATE:${formatDate(start, true)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDate(end, true)}`);
    lines.push(`SUMMARY:${escapeICS(summary)}`);
    if (description) lines.push(`DESCRIPTION:${escapeICS(description)}`);
    if (loc?.name) lines.push(`LOCATION:${escapeICS(loc.name)}`);
    lines.push("END:VEVENT");
  }

  for (const a of filteredAppts) {
    if (!a.start_time) continue;
    const job = Array.isArray(a.job) ? a.job[0] : a.job;
    if (job && (job.status === "storniert" || job.is_deleted)) continue;
    const start = new Date(a.start_time);
    const end = a.end_time ? new Date(a.end_time) : new Date(start.getTime() + 60 * 60 * 1000);
    const summary = job?.job_number
      ? `${a.title} (INT-${job.job_number})`
      : a.title;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:appt-${a.id}@eventline-basel.com`);
    lines.push(`DTSTAMP:${nowStr}`);
    lines.push(`DTSTART:${formatDate(start, false)}`);
    lines.push(`DTEND:${formatDate(end, false)}`);
    lines.push(`SUMMARY:${escapeICS(summary)}`);
    if (job?.title) lines.push(`DESCRIPTION:${escapeICS(job.title)}`);
    lines.push("END:VEVENT");
  }

  // Projekt-Termine: gleiche Sichtbarkeits-Regel wie im Kalender selbst —
  // Admin sieht alles; MA sieht Termine wo er Member/Assignee/Creator/
  // Participant ist. Wir laden alles und filtern client-seitig (kleine
  // Datenmenge — Projekte sind viel weniger als Jobs).
  const { data: projAppts } = await supabase
    .from("project_appointments")
    .select("id, title, description, start_time, end_time, project:projects(id, project_number, title, status, is_deleted, assigned_to, created_by)");
  const { data: myMemberships } = !isAdmin
    ? await supabase.from("project_members").select("project_id").eq("user_id", userId)
    : { data: [] as { project_id: string }[] };
  const { data: myParticipations } = !isAdmin
    ? await supabase.from("project_appointment_participants").select("appointment_id").eq("profile_id", userId)
    : { data: [] as { appointment_id: string }[] };
  const myMemberProjectIds = new Set((myMemberships ?? []).map((m) => m.project_id as string));
  const myParticipationIds = new Set((myParticipations ?? []).map((p) => p.appointment_id as string));

  for (const a of projAppts ?? []) {
    if (!a.start_time) continue;
    const proj = Array.isArray(a.project) ? a.project[0] : a.project;
    if (!proj) continue;
    if (proj.is_deleted || proj.status === "storniert") continue;

    const visible = isAdmin
      || myMemberProjectIds.has(proj.id as string)
      || myParticipationIds.has(a.id as string)
      || proj.assigned_to === userId
      || proj.created_by === userId;
    if (!visible) continue;

    const start = new Date(a.start_time);
    const end = a.end_time ? new Date(a.end_time) : new Date(start.getTime() + 60 * 60 * 1000);
    const prjLabel = proj.project_number != null ? `PROJ-${proj.project_number}` : "PROJ";
    const summary = `${a.title} (${prjLabel})`;
    const description = [proj.title, a.description].filter(Boolean).join("\n\n");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:proj-appt-${a.id}@eventline-basel.com`);
    lines.push(`DTSTAMP:${nowStr}`);
    lines.push(`DTSTART:${formatDate(start, false)}`);
    lines.push(`DTEND:${formatDate(end, false)}`);
    lines.push(`SUMMARY:${escapeICS(summary)}`);
    if (description) lines.push(`DESCRIPTION:${escapeICS(description)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return new NextResponse(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // private weil pro User unterschiedlich; max-age=600 fuer Browser/
      // App-Cache, kein s-maxage damit CDNs nichts shared cachen.
      "Cache-Control": "private, max-age=600",
    },
  });
}
