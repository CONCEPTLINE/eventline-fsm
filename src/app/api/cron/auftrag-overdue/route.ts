// GET /api/cron/auftrag-overdue
//
// Taeglicher Cron (Vercel schedule "0 9 * * *" = 09:00 UTC → 10:00 ZRH
// Winter / 11:00 ZRH Sommer, kurz nach Buero-Start). Sucht ueberfaellige
// Auftraege und schickt gestaffelt Reminder aus:
//
//   Tag +1 nach end_date
//     → in-app Notification an alle zugewiesenen MA (kind='notification')
//     → Email an alle zugewiesenen MA               (kind='mail')
//       Beides im gleichen Cron-Lauf, direkt hintereinander.
//
//   Tag +3 nach end_date
//     → Email an den Team-Leader (profiles.team_lead_id, aus Migration 208)
//       jedes zugewiesenen MA                       (kind='mail_lead')
//       MA ohne Team-Leader werden geskippt (kein Crash).
//       Mehrere MA mit demselben Team-Leader → nur EINE Mail pro Leader
//       pro Auftrag (Dedup nach lead_id).
//       Zusaetzlich CC an alle aktiven Admins (profiles.role='admin',
//       is_active=true, email IS NOT NULL). Admin-Emails werden gegen
//       die Team-Lead-Empfaenger-Adresse dedupliziert (falls Team-Lead
//       selbst Admin ist → nur TO, kein doppelter CC).
//
// Idempotenz: pro (job_id, kind) genau EINE Row in job_overdue_reminders
// (Migration 205; kind-Set erweitert um 'mail_lead' in Migration 210).
// Cron skippt Auftraege, fuer die die Row schon existiert. So laeuft der
// Cron risikofrei taeglich, ohne Dubletten zu produzieren. Weil
// 'notification' und 'mail' unterschiedliche kinds sind, laufen beide
// Tag+1-Reminder unabhaengig durch die Idempotenz — schlaegt einer fehl
// (z.B. RESEND-Key fehlt), kann er beim naechsten Cron-Lauf nachgeholt
// werden, ohne dass der jeweils andere doppelt rausgeht.
//
// Nachhol-lauf: der Cron feuert an >=1 (Tag+1-Kinds) bzw. >=3 (mail_lead),
// nicht auf === Tag 1 / === Tag 3. So holt ein zwischen zwei Cron-Laeufen
// ausgefallener Vercel-Cron den Reminder am naechsten Tag nach, statt ihn
// dauerhaft zu verlieren. Die Idempotenz-Row (job_id, kind) verhindert,
// dass ein Auftrag mehr als einmal je Reminder-Art angepingt wird.
//
// Filter fuer "ueberfaellige Auftraege":
//   - status NOT IN ('abgeschlossen', 'storniert', 'entwurf', 'anfrage')
//     → nur echte, laufende Auftraege
//   - end_date IS NOT NULL
//   - end_date::date < heute (Europe/Zurich-Kalender)
//
// Rueckgabe: {total_notified, total_mailed, total_lead_mailed, skipped, errors}.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayLocalIso } from "@/lib/swiss-time";
import { notifyJobOverdueDay1 } from "@/lib/notification-service";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { sendMailBatch, mailRahmen, isMailConfigured, mailErrorMessage } from "@/lib/mail";
import { logError } from "@/lib/log";

const ACTIVE_STATUSES_EXCLUDED = ["abgeschlossen", "storniert", "entwurf", "anfrage"];

interface JobRow {
  id: string;
  job_number: number;
  title: string;
  end_date: string; // timestamptz
  status: string;
}

interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string | null;
  team_lead_id: string | null;
}

/** Tage-Differenz zwischen zwei YYYY-MM-DD-Strings im Europe/Zurich-Kalender. */
function daysBetweenIso(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000));
}

/** end_date liegt als timestamptz vor — fuer den Vergleich brauchen wir nur
 *  das ZRH-Datum. dateFormat aus swiss-time waere sauberer, aber die
 *  timestamptz aus der DB ist bereits UTC, und wir wollen den ZRH-Kalendertag
 *  der end_date. Die Zeit-Komponente (typisch 00:00 UTC) ist irrelevant. */
function endDateToLocalIso(endTs: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(endTs));
}

/** Datums-Anzeige fuer den Mail-Text — immer Europe/Zurich, dd.mm.yyyy. */
function formatEndHuman(endTs: string): string {
  return new Date(endTs).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "CRON_SECRET fehlt in der Server-Config" },
      { status: 503 },
    );
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const today = todayLocalIso();

  // Alle Auftraege mit Enddatum vor heute und noch laufendem Status laden.
  // Wir vergleichen end_date als timestamptz gegen Mitternacht ZRH heute —
  // Kandidaten enthalten damit auch alles was heute morgen bereits vorbei
  // war. Der endgueltige Tage-Filter (=== 1, === 3) passiert unten in JS.
  const { data: jobs, error: jobsErr } = await admin
    .from("jobs")
    .select("id, job_number, title, end_date, status")
    .not("end_date", "is", null)
    .not("status", "in", `(${ACTIVE_STATUSES_EXCLUDED.map((s) => `"${s}"`).join(",")})`)
    .lt("end_date", `${today}T00:00:00+02:00`);
  if (jobsErr) {
    logError("cron.auftrag-overdue.load-jobs", jobsErr);
    return NextResponse.json({ error: jobsErr.message }, { status: 500 });
  }

  const overdueJobs = (jobs ?? []) as JobRow[];
  if (overdueJobs.length === 0) {
    return NextResponse.json({
      ok: true,
      today,
      candidates: 0,
      total_notified: 0,
      total_mailed: 0,
      total_lead_mailed: 0,
    });
  }

  // Alle bereits versendeten Reminder in EINEM Query holen — statt pro Job
  // eine Query, die skalieren wuerde uebel bei 100+ ueberfaelligen Auftraegen.
  const jobIds = overdueJobs.map((j) => j.id);
  const { data: existingReminders } = await admin
    .from("job_overdue_reminders")
    .select("job_id, kind")
    .in("job_id", jobIds);
  const alreadySent = new Set<string>();
  for (const r of (existingReminders ?? []) as Array<{ job_id: string; kind: string }>) {
    alreadySent.add(`${r.job_id}::${r.kind}`);
  }

  // Assignees pro Job laden — job_appointments.assigned_to dedupliziert
  // (mehrere Termine je Auftrag fuer denselben MA → EIN Reminder).
  const { data: apptRows } = await admin
    .from("job_appointments")
    .select("job_id, assigned_to")
    .in("job_id", jobIds)
    .not("assigned_to", "is", null);
  const assigneesByJob = new Map<string, Set<string>>();
  for (const r of (apptRows ?? []) as Array<{ job_id: string; assigned_to: string }>) {
    let set = assigneesByJob.get(r.job_id);
    if (!set) {
      set = new Set<string>();
      assigneesByJob.set(r.job_id, set);
    }
    set.add(r.assigned_to);
  }

  // Profil-Daten fuer alle betroffenen User in EINEM Query.
  // team_lead_id brauchen wir fuer die Tag+3-Mail an den Team-Leader.
  // Zuerst nur die Assignee-IDs — die Team-Leader-Profile werden in einem
  // zweiten Query nachgeladen (typisch << Assignee-Anzahl).
  const assigneeUserIds = Array.from(new Set(
    Array.from(assigneesByJob.values()).flatMap((s) => Array.from(s)),
  ));
  const profilesById = new Map<string, ProfileRow>();
  if (assigneeUserIds.length > 0) {
    const { data: profileRows } = await admin
      .from("profiles")
      .select("id, full_name, email, team_lead_id")
      .in("id", assigneeUserIds)
      .eq("is_active", true);
    for (const p of (profileRows ?? []) as ProfileRow[]) {
      profilesById.set(p.id, p);
    }
  }

  // Team-Leader-Profile nachladen (nur id, full_name, email; team_lead_id
  // des Leaders interessiert hier nicht — Reminder eskalieren nicht rekursiv).
  const leadIds = Array.from(new Set(
    Array.from(profilesById.values())
      .map((p) => p.team_lead_id)
      .filter((v): v is string => !!v),
  ));
  const leadsById = new Map<string, ProfileRow>();
  if (leadIds.length > 0) {
    const { data: leadRows } = await admin
      .from("profiles")
      .select("id, full_name, email, team_lead_id")
      .in("id", leadIds)
      .eq("is_active", true);
    for (const l of (leadRows ?? []) as ProfileRow[]) {
      leadsById.set(l.id, l);
    }
  }

  // Company nur EINMAL laden statt pro Auftrag. Absender ist der zentrale
  // Default aus lib/mail (formatMailFrom + noreply@eventline-basel.com).
  const company = await loadCompanySettings(admin);
  const mailOk = isMailConfigured();
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://eventline-basel.com";

  // Empfaenger fuer den Tag+3-CC einmalig laden: alle aktiven Profile,
  // deren Rolle 'auftraege:see-all' hat (Admin-Rolle immer) — statt
  // hardcoded role='admin', damit z.B. eine Einsatzleitungs-Rolle mit
  // Vollsicht die Eskalation ebenfalls mitkriegt. Wird pro Lead-Mail als
  // CC beigelegt, mit Dedup gegen die TO-Adresse (Team-Lead selbst in der
  // Empfaengerliste → nur TO, kein doppelter CC).
  const ccRecipientIds = await recipientsWithPermission(admin, "auftraege:see-all");
  let adminEmails: string[] = [];
  if (ccRecipientIds.length > 0) {
    const { data: adminRows } = await admin
      .from("profiles")
      .select("email")
      .in("id", ccRecipientIds)
      .not("email", "is", null);
    adminEmails = ((adminRows ?? []) as Array<{ email: string | null }>)
      .map((r) => r.email)
      .filter((e): e is string => !!e);
  }

  let totalNotified = 0;
  let totalMailed = 0;
  let totalLeadMailed = 0;
  let skipped = 0;
  const errors: Array<{ job_id: string; kind: string; error: string }> = [];

  // Mails werden in der Schleife nur GESAMMELT und danach als EIN Batch
  // verschickt (vorher seriell pro Empfaenger → Timeout-/Doppelversand-
  // Risiko bei vielen ueberfaelligen Auftraegen).
  type PendingMail = {
    to: string;
    cc?: string[];
    subject: string;
    html: string;
    jobId: string;
    kind: "mail" | "mail_lead";
    recipientId: string;
  };
  const pendingMails: PendingMail[] = [];

  /** Reminder-Row idempotent anlegen. 23505 (unique_violation) = eine
   *  zweite Cron-Instanz war schneller → nicht als Fehler zaehlen. */
  async function markSent(jobId: string, kind: string, sentUserIds: string[]) {
    const { error: insErr } = await admin
      .from("job_overdue_reminders")
      .insert({ job_id: jobId, kind, sent_to_user_ids: sentUserIds });
    if (insErr && insErr.code !== "23505") {
      errors.push({ job_id: jobId, kind, error: insErr.message });
    }
  }

  for (const job of overdueJobs) {
    const endIso = endDateToLocalIso(job.end_date);
    const overdueDays = daysBetweenIso(endIso, today);

    // Alles ab Tag +1 ist ein Kandidat fuer die Tag+1-Reminder, alles ab
    // Tag +3 zusaetzlich fuer die Tag+3-Lead-Mail. Frueher haben wir hart
    // auf === 1 bzw. === 3 gefiltert — Nachteil: verpasst der Cron einen
    // Tag (Vercel-Ausfall), fiel der Reminder DAUERHAFT aus. Jetzt >=1/>=3:
    // Nachhol-lauf greift, Duplikate verhindert die unique-Constraint
    // (job_id, kind) via markSent + alreadySent-Check.
    if (overdueDays < 1) {
      skipped++;
      continue;
    }

    const assigneeIds = Array.from(assigneesByJob.get(job.id) ?? []);
    const endHuman = formatEndHuman(job.end_date);
    const link = `${appBaseUrl}/auftraege/${job.id}`;

    // Kein Assignee → alle relevanten Reminder-Kinds trotzdem als Marker
    // eintragen, damit der Cron morgen nicht wieder rein-laeuft.
    if (assigneeIds.length === 0) {
      const kinds: string[] = ["notification", "mail"];
      if (overdueDays >= 3) kinds.push("mail_lead");
      for (const kind of kinds) {
        if (alreadySent.has(`${job.id}::${kind}`)) continue;
        await markSent(job.id, kind, []);
      }
      skipped++;
      continue;
    }

    // ─────────── Tag +1 (bzw. spaeter im Nachhol-lauf): In-App + Mail an alle MA ───────────
    if (overdueDays >= 1) {
      // In-App Notification
      if (!alreadySent.has(`${job.id}::notification`)) {
        try {
          await notifyJobOverdueDay1(admin, {
            recipients: assigneeIds,
            jobId: job.id,
            jobNumber: job.job_number,
            jobTitle: job.title,
            endDateIso: endIso,
          });
          totalNotified += assigneeIds.length;
          await markSent(job.id, "notification", assigneeIds);
        } catch (e) {
          logError("cron.auftrag-overdue.notification", e, { jobId: job.id });
          errors.push({
            job_id: job.id,
            kind: "notification",
            error: e instanceof Error ? e.message : "unknown",
          });
        }
      }

      // Mail an dieselben MA — via zentralem Batch-Versand, umgeht bewusst
      // user_notification_settings (Reminder muss zwingend raus).
      if (!alreadySent.has(`${job.id}::mail`)) {
        if (!mailOk) {
          errors.push({ job_id: job.id, kind: "mail", error: "Kein RESEND_API_KEY" });
        } else {
          const targets = assigneeIds
            .map((id) => profilesById.get(id))
            .filter((p): p is ProfileRow & { email: string } => !!p && !!p.email);
          const subject = `[EVENTLINE] Auftrag INT-${job.job_number} seit gestern ueberfaellig`;
          for (const t of targets) {
            const greeting = t.full_name ? t.full_name.split(" ")[0] : "";
            pendingMails.push({
              to: t.email,
              subject,
              html: mailRahmen({
                titel: company.name,
                inhaltHtml: `
                  <p style="margin:0 0 12px">Hallo ${greeting || "zusammen"},</p>
                  <p style="margin:0 0 16px">Der Auftrag <strong>INT-${job.job_number} ${escapeHtml(job.title)}</strong> war fuer den <strong>${endHuman}</strong> geplant und ist noch nicht abgeschlossen.</p>
                  <p style="margin:0 0 20px">Bitte pruefe den Status und schliesse den Auftrag ab oder aktualisiere das Enddatum.</p>
                  <p style="margin:0 0 24px">
                    <a href="${link}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Zum Auftrag</a>
                  </p>
                  <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
                  <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
                `,
              }),
              jobId: job.id,
              kind: "mail",
              recipientId: t.id,
            });
          }
        }
      }
    }

    // ─────────── Tag +3 (bzw. spaeter im Nachhol-lauf): Mail an den Team-Leader jedes MA ───────────
    if (overdueDays >= 3) {
      if (alreadySent.has(`${job.id}::mail_lead`)) {
        skipped++;
        continue;
      }
      // Team-Leader pro MA aufloesen und pro Leader dedupen — mehrere MA
      // desselben Leaders → nur eine Mail. Wir speichern die Namen der
      // "betroffenen" MA pro Lead, damit die Mail auflisten kann welche
      // Mitarbeiter das betrifft.
      const membersByLead = new Map<string, ProfileRow[]>();
      for (const uid of assigneeIds) {
        const member = profilesById.get(uid);
        if (!member || !member.team_lead_id) continue;
        const lead = leadsById.get(member.team_lead_id);
        if (!lead || !lead.email) continue;
        let list = membersByLead.get(lead.id);
        if (!list) {
          list = [];
          membersByLead.set(lead.id, list);
        }
        list.push(member);
      }

      if (membersByLead.size === 0) {
        // Kein Team-Leader zu finden (kein MA hat team_lead_id oder alle
        // Leader ohne Email). Reminder-Row trotzdem eintragen, damit der
        // Cron morgen nicht wieder rein-laeuft.
        await markSent(job.id, "mail_lead", []);
        skipped++;
        continue;
      }

      if (!mailOk) {
        errors.push({ job_id: job.id, kind: "mail_lead", error: "Kein RESEND_API_KEY" });
        continue;
      }

      for (const [leadId, members] of membersByLead) {
        const lead = leadsById.get(leadId);
        if (!lead || !lead.email) continue;
        // Wenn genau EIN MA betroffen: Name im Betreff. Bei mehreren:
        // Anzahl im Betreff, Liste im Body.
        const memberNames = members
          .map((m) => m.full_name || m.email || "Mitarbeiter")
          .join(", ");
        const subject = members.length === 1
          ? `[EVENTLINE] Team-Mitglied ${members[0].full_name || members[0].email || "MA"} hat Auftrag INT-${job.job_number} noch nicht abgeschlossen (3 Tage ueberfaellig)`
          : `[EVENTLINE] ${members.length} Team-Mitglieder haben Auftrag INT-${job.job_number} noch nicht abgeschlossen (3 Tage ueberfaellig)`;
        const greeting = lead.full_name ? lead.full_name.split(" ")[0] : "";
        // CC an alle Empfaenger mit 'auftraege:see-all' — case-insensitiv
        // gegen die TO-Adresse dedupliziert (Team-Lead selbst dabei → nur TO).
        const leadEmailLc = lead.email.toLowerCase();
        const ccEmails = adminEmails.filter((e) => e.toLowerCase() !== leadEmailLc);
        pendingMails.push({
          to: lead.email,
          cc: ccEmails.length > 0 ? ccEmails : undefined,
          subject,
          html: mailRahmen({
            titel: company.name,
            inhaltHtml: `
              <p style="margin:0 0 12px">Hallo ${greeting || "zusammen"},</p>
              <p style="margin:0 0 16px">Der Auftrag <strong>INT-${job.job_number} ${escapeHtml(job.title)}</strong> war fuer den <strong>${endHuman}</strong> geplant und ist seit 3 Tagen nicht abgeschlossen.</p>
              <p style="margin:0 0 16px">Betroffene${members.length === 1 ? "r Mitarbeiter" : " Mitarbeiter"} in deinem Team: <strong>${escapeHtml(memberNames)}</strong>.</p>
              <p style="margin:0 0 20px">Bitte hake bei ${members.length === 1 ? "ihm/ihr" : "ihnen"} nach und stell sicher, dass der Auftrag abgeschlossen oder das Enddatum aktualisiert wird.</p>
              <p style="margin:0 0 24px">
                <a href="${link}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Zum Auftrag</a>
              </p>
              <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
              <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
            `,
          }),
          jobId: job.id,
          kind: "mail_lead",
          recipientId: lead.id,
        });
      }
    }
  }

  // ── Batch-Versand aller gesammelten Mails + markSent je Gruppe ──────
  if (pendingMails.length > 0) {
    const { sent, failed } = await sendMailBatch(pendingMails);
    for (const f of failed) {
      if (f.mail.kind === "mail") {
        logError("cron.auftrag-overdue.mail", f.error, { jobId: f.mail.jobId, email: f.mail.to });
      } else {
        logError("cron.auftrag-overdue.mail-lead", f.error, { jobId: f.mail.jobId, leadEmail: f.mail.to });
      }
      errors.push({
        job_id: f.mail.jobId,
        kind: f.mail.kind,
        error: `${f.mail.kind} to ${f.mail.to}: ${mailErrorMessage(f.error) ?? "unknown"}`,
      });
    }

    // Erfolge je (job_id, kind) gruppieren — Doppelversand-Schutz-Semantik
    // erhalten: Reminder-Row erst NACH dem Batch der Gruppe, und nur wenn
    // mindestens eine Mail durchging (sonst zieht der naechste Cron-Lauf
    // nach, z.B. wenn der RESEND-Key inzwischen gesetzt wurde).
    const sentByGroup = new Map<string, { job_id: string; kind: string; sent_to_user_ids: string[] }>();
    for (const m of sent) {
      if (m.kind === "mail") totalMailed++;
      else totalLeadMailed++;
      const key = `${m.jobId}::${m.kind}`;
      const acc = sentByGroup.get(key);
      if (acc) acc.sent_to_user_ids.push(m.recipientId);
      else sentByGroup.set(key, { job_id: m.jobId, kind: m.kind, sent_to_user_ids: [m.recipientId] });
    }
    const reminderRows = Array.from(sentByGroup.values());
    if (reminderRows.length > 0) {
      // EIN Bulk-Insert statt pro Empfaengergruppe; ignoreDuplicates deckt
      // die bisherige 23505-Toleranz ab (parallele Cron-Instanz war schneller).
      const { error: bulkErr } = await admin
        .from("job_overdue_reminders")
        .upsert(reminderRows, { onConflict: "job_id,kind", ignoreDuplicates: true });
      if (bulkErr) {
        for (const r of reminderRows) {
          errors.push({ job_id: r.job_id, kind: r.kind, error: bulkErr.message });
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    today,
    candidates: overdueJobs.length,
    total_notified: totalNotified,
    total_mailed: totalMailed,
    total_lead_mailed: totalLeadMailed,
    skipped,
    errors,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
