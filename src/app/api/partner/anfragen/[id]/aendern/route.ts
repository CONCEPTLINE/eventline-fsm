// POST /api/partner/anfragen/[id]/aendern — Partner versetzt seine
// BESTAETIGTE Anfrage zurueck in den Aenderungsmodus (Vorfall Barakuba:
// Zeitaenderung ging per Mail unter, Techniker kam zu spaet — jetzt
// laeuft die Aenderung strukturiert uebers Portal).
//
// Ablauf:
//   1. Snapshot der aktuellen Werte + Termine nach jobs.partner_aenderung
//      (fuer den Vorher/Nachher-Vergleich im Firmenportal),
//   2. Status 'offen' -> 'partner_anfrage' (Partner kann sofort im
//      gewohnten Editor arbeiten, RLS-Regeln greifen wieder),
//   3. SOFORT-Alarm an die Zustaendigen (in-App + Mail) und an bereits
//      zugeteilte Techniker (in-App) — nichts geht mehr unter.
//
// Sicherheit: nur der Partner der Location dieses Auftrags (gleiche
// Bedingung wie die RLS-Partner-Klauseln), nur aus Status 'offen'.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { notifySystem } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { sendMailBatch, mailRahmen, isMailConfigured } from "@/lib/mail";
import { appUrl } from "@/lib/app-url";
import { formatJobNumber } from "@/lib/nummern-format";
import { todayLocalIso } from "@/lib/swiss-time";
import { logError } from "@/lib/log";

// Portal-Aenderungen nur bis X Tage vor der Veranstaltung — danach ist
// die Disposition zu knapp, Aenderungen laufen direkt ueber EVENTLINE.
// (Kein export — Next erlaubt in route.ts nur Handler-Exports; der
// gleiche Wert steht im Portal-UI, src/app/partner/.../[id]/page.tsx.)
const AENDERUNG_SPERRFRIST_TAGE = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: "Ungültige ID" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, partner_location_id, is_active, full_name")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (!profile || profile.is_active === false || profile.role !== "partner" || !profile.partner_location_id) {
    return NextResponse.json({ success: false, error: "Kein Zugriff" }, { status: 403 });
  }

  const { data: job } = await admin
    .from("jobs")
    .select("id, job_number, title, description, start_date, end_date, status, location_id, contact_person, contact_phone, contact_email, location:locations(name)")
    .eq("id", id)
    .maybeSingle();
  if (!job || job.location_id !== profile.partner_location_id) {
    return NextResponse.json({ success: false, error: "Anfrage nicht gefunden" }, { status: 404 });
  }
  if (job.status !== "offen") {
    return NextResponse.json(
      { success: false, error: "Nur bestätigte Anfragen können in den Änderungsmodus zurück" },
      { status: 400 },
    );
  }
  // Sperrfrist (Leo 2026-09-26): weniger als 3 Tage vor der Veranstaltung
  // keine Portal-Aenderungen mehr — Kalendertage Europe/Zurich.
  if (job.start_date) {
    const tageBis = Math.round(
      (Date.parse(String(job.start_date).slice(0, 10)) - Date.parse(todayLocalIso())) / 86_400_000,
    );
    if (tageBis < AENDERUNG_SPERRFRIST_TAGE) {
      return NextResponse.json(
        {
          success: false,
          error: `Weniger als ${AENDERUNG_SPERRFRIST_TAGE} Tage bis zur Veranstaltung — Änderungen jetzt bitte direkt mit EVENTLINE besprechen.`,
        },
        { status: 400 },
      );
    }
  }

  try {
    const { data: termine } = await admin
      .from("job_appointments")
      .select("title, start_time, end_time")
      .eq("job_id", id)
      .order("start_time");

    const snapshot = {
      von_status: "offen",
      vorher: {
        title: job.title,
        description: job.description,
        start_date: job.start_date,
        end_date: job.end_date,
        contact_person: job.contact_person,
        contact_phone: job.contact_phone,
        contact_email: job.contact_email,
      },
      termine_vorher: termine ?? [],
      eingereicht_at: new Date().toISOString(),
      eingereicht_von: profile.full_name ?? "Partner",
    };

    // Atomar nur aus 'offen' — zwei parallele Klicks erzeugen keinen
    // doppelten Snapshot.
    const { count, error } = await admin
      .from("jobs")
      .update(
        { status: "partner_anfrage", partner_aenderung: snapshot, submitted_at: snapshot.eingereicht_at },
        { count: "exact" },
      )
      .eq("id", id)
      .eq("status", "offen");
    if (error) throw error;
    if (count === 0) {
      return NextResponse.json({ success: false, error: "Anfrage wurde inzwischen verändert" }, { status: 409 });
    }

    // ── Sofort-Alarm intern ────────────────────────────────────────
    const loc = Array.isArray(job.location) ? job.location[0] : job.location;
    const locationName = (loc as { name?: string } | null)?.name ?? "Location";
    const nr = formatJobNumber(job.job_number);
    const titel = `Partner-Änderung: ${job.title}`;
    const text = `${snapshot.eingereicht_von} (${locationName}) passt die bestätigte Anfrage ${nr} an — bitte prüfen und die Änderung bestätigen.`;
    const link = `/auftraege/${id}`;

    const zustaendige = await recipientsWithPermission(admin, "auftraege:edit");
    await notifySystem(admin, { recipients: zustaendige, title: titel, message: text, link });

    // Zugeteilte Techniker in-App informieren (der Vorfall: Techniker
    // wusste nichts von der Zeitaenderung).
    const { data: zugeteilt } = await admin
      .from("job_appointments")
      .select("assigned_to")
      .eq("job_id", id)
      .not("assigned_to", "is", null);
    const technikerIds = Array.from(new Set(((zugeteilt ?? []) as { assigned_to: string }[]).map((z) => z.assigned_to)))
      .filter((uid) => !zustaendige.includes(uid));
    if (technikerIds.length > 0) {
      await notifySystem(admin, {
        recipients: technikerIds,
        title: titel,
        message: `Achtung: Der Partner ändert die bestätigte Anfrage ${nr} — Termine können sich verschieben.`,
        link,
      });
    }

    // Mail an die Zustaendigen — der Vorfall entstand, weil eine Mail
    // unterging; jetzt geht sie strukturiert an ALLE Zustaendigen.
    if (isMailConfigured() && zustaendige.length > 0) {
      const { data: mailProfiles } = await admin
        .from("profiles")
        .select("email")
        .in("id", zustaendige)
        .eq("is_active", true)
        .not("email", "is", null);
      const mails = ((mailProfiles ?? []) as { email: string }[]).map((p) => ({
        to: p.email,
        subject: `${titel} (${nr})`,
        html: mailRahmen({
          titel: "Partner ändert bestätigte Anfrage",
          inhaltHtml: `<p>${text}</p><p>Der Auftrag steht wieder auf <strong>ausstehend</strong>, bis die Änderung bestätigt ist.</p><p><a href="${appUrl(link)}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Anfrage prüfen</a></p>`,
        }),
      }));
      await sendMailBatch(mails).catch((e) => logError("api.partner.aendern.mail", e, { jobId: id }));
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    logError("api.partner.aendern", e, { jobId: id });
    return NextResponse.json({ success: false, error: "Aktion fehlgeschlagen" }, { status: 500 });
  }
}
