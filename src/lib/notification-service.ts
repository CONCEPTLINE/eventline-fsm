/**
 * NotificationService — zentrale Eintritts-Schicht fuer alle In-App-
 * Benachrichtigungen.
 *
 * Statt dass jeder API-Endpoint sein eigenes
 *   supabase.from("notifications").insert({ title, message, link, type, ... })
 * baut, ruft er hier eine typisierte Funktion:
 *   await notifyTicketNew(admin, { ticketNumber, title, ticketType, byUser })
 *
 * Vorteile:
 *  - Konsistente Titles/Messages/Links app-weit
 *  - Neuer Empfaengerkreis oder neues Format an einer Stelle
 *  - Zukuenftig: Channel-Filter (In-App/Mail/Push) basierend auf
 *    user_notification_settings, ohne Endpoint-Refactor
 *  - Smart-Defaults wie Buendelung/Throttling zentralisieren leicht
 *
 * KONVENTIONEN
 *  - Receiver: Array von Profile-IDs. Empty-Array = no-op (kein Crash).
 *  - Service-Funktionen bauen Title/Message/Link selbst — Caller liefert
 *    nur den semantischen Kontext (z.B. ticketNumber + title).
 *  - Result ist immer void. Fehler werden geloggt aber NICHT geworfen
 *    (Notification-Failure soll nie eine Business-Aktion blockieren).
 *
 * USAGE (api-side mit admin client):
 *   import { createAdminClient } from "@/lib/supabase/admin";
 *   import { notifyTicketNew } from "@/lib/notification-service";
 *
 *   await notifyTicketNew(createAdminClient(), {
 *     recipients: adminIds,
 *     ticketNumber: 42,
 *     ticketTitle: "Drucker streikt",
 *     ticketType: "it",
 *     byName: "Mathis",
 *   });
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { logError } from "@/lib/log";
import type { NotificationType } from "@/types";
import { loadCompanySettings, formatMailFrom } from "@/lib/company-settings";

// VAPID-Setup: einmal beim Modul-Load. Wenn die Keys fehlen, wird Push
// stillschweigend deaktiviert (In-App-Notifs bleiben aktiv).
const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:admin@eventline-basel.com";
const PUSH_ENABLED = VAPID_PUBLIC.length > 0 && VAPID_PRIVATE.length > 0;
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

interface NotificationRow {
  user_id: string;
  type: NotificationType;
  title: string;
  message: string | null;
  link: string | null;
  resource_type: string | null;
  resource_id: string | null;
}

// Fenster fuer Buendelung: kommt eine neue Notif fuer (user, type) und
// existiert ein ungelesener Eintrag dieser Kombination der vor max
// BUNDLE_WINDOW_MIN gepostet wurde -> stattdessen bundle_count hochziehen
// (statt neuer INSERT). Verhindert dass z.B. 5 Auftrags-Zuweisungen
// morgens als 5 separate Eintraege landen.
const BUNDLE_WINDOW_MIN = 5;

/** Low-level Insert mit Buendelung: pro Row erst pruefen ob ein
 *  ungelesener Eintrag derselben (user_id, type) innerhalb des Fensters
 *  existiert -> UPDATE bundle_count statt INSERT. Best-effort. */
async function insertMany(client: SupabaseClient, rows: NotificationRow[]) {
  if (rows.length === 0) return;
  // type='system' wird NICHT gebuendelt — jede Mitteilung/Erinnerung hat
  // unique Title+Message, "5x Mitteilung: <einer von fuenf>" verschluckt
  // die anderen vier. Event-Typen (ticket_new, todo_assigned, ...) buendeln
  // weiter, weil dort die Titel-Vorlage identisch ist.
  const bundlableRows = rows.filter((r) => r.type !== "system");
  const standaloneRows = rows.filter((r) => r.type === "system");
  if (standaloneRows.length > 0) {
    const { error } = await client.from("notifications").insert(standaloneRows);
    if (error) logError("notification-service.insert.standalone", error, { count: standaloneRows.length });
  }
  if (bundlableRows.length === 0) return;
  const cutoff = new Date(Date.now() - BUNDLE_WINDOW_MIN * 60_000).toISOString();
  // Pro Row erst Bundle-Lookup. Wir laden alle Kandidaten in EINEM Query
  // (IN/OR) und bauen dann lokal die Entscheidung.
  const userIds = Array.from(new Set(bundlableRows.map((r) => r.user_id)));
  const types = Array.from(new Set(bundlableRows.map((r) => r.type)));
  const { data: existing } = await client
    .from("notifications")
    .select("id, user_id, type, bundle_count, title, message")
    .in("user_id", userIds)
    .in("type", types)
    .eq("is_read", false)
    .gte("created_at", cutoff);
  const bundleMap = new Map<string, { id: string; bundle_count: number; title: string; message: string | null }>();
  for (const row of (existing ?? []) as { id: string; user_id: string; type: string; bundle_count: number; title: string; message: string | null }[]) {
    bundleMap.set(`${row.user_id}::${row.type}`, row);
  }
  const toInsert: NotificationRow[] = [];
  const toBumpById = new Map<string, { count: number; title: string; latest: NotificationRow }>();
  for (const r of bundlableRows) {
    const key = `${r.user_id}::${r.type}`;
    const existing = bundleMap.get(key);
    if (existing) {
      const acc = toBumpById.get(existing.id);
      if (acc) {
        acc.count += 1;
        acc.latest = r;
      } else {
        toBumpById.set(existing.id, {
          count: existing.bundle_count + 1,
          title: existing.title,
          latest: r,
        });
      }
    } else {
      toInsert.push(r);
      // Damit nachfolgende Rows zum gleichen (user, type) in DIESEM Batch
      // auf den gerade frisch geplanten Eintrag buendeln (zukuenftig).
      bundleMap.set(key, { id: `__pending::${key}`, bundle_count: 1, title: r.title, message: r.message });
    }
  }
  if (toInsert.length > 0) {
    const { error } = await client.from("notifications").insert(toInsert);
    if (error) logError("notification-service.insert", error, { count: toInsert.length });
  }
  // Bundle-Updates parallel: bundle_count rauf + Title zu "Sammeleintrag",
  // Message bekommt den neuesten Subtitel-Hint, created_at refresh.
  await Promise.all(Array.from(toBumpById.entries()).map(([id, acc]) =>
    client.from("notifications").update({
      bundle_count: acc.count,
      title: `${acc.count}× ${stripCount(acc.title)}`,
      message: acc.latest.message,
      link: acc.latest.link,
      created_at: new Date().toISOString(),
    }).eq("id", id),
  ));
}

/** "5× Neues Ticket: X" -> "Neues Ticket: X" damit der Multiplier nicht
 *  bei jedem Bundle-Update verschachtelt wird. */
function stripCount(title: string): string {
  return title.replace(/^\d+×\s+/, "");
}

/** Erzeugt eine Row pro Empfaenger mit gleichem Body. */
function fanOut<T extends Omit<NotificationRow, "user_id">>(
  recipients: string[],
  base: T,
): NotificationRow[] {
  const seen = new Set<string>();
  return recipients
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((user_id) => ({ user_id, ...base }));
}

/** Lookup welche Channels pro Empfaenger aktiv sind. Liefert Map
 *  user_id -> {in_app, push, email}.
 *
 *  Defaults sind rollenabhaengig — Partner haben keine Bell im Portal,
 *  deshalb ist fuer sie E-Mail default AN. Interne User haben die Bell,
 *  fuer sie ist In-App default AN und Mail default aus.
 *
 *   Rolle      | in_app | push | email
 *   -----------|--------|------|------
 *   partner    | true   | false| true
 *   sonst      | true   | false| false
 */
async function lookupChannels(
  client: SupabaseClient,
  recipients: string[],
  type: NotificationType,
): Promise<Map<string, { in_app: boolean; push: boolean; email: boolean }>> {
  const result = new Map<string, { in_app: boolean; push: boolean; email: boolean }>();
  if (recipients.length === 0) return result;
  // Rollen aller Empfaenger laden — bestimmt den Default-Fallback
  // wenn der User noch keine explizite Setting-Zeile hat.
  const { data: profileRows } = await client
    .from("profiles")
    .select("id, role")
    .in("id", recipients);
  const roleById = new Map<string, string>();
  for (const p of (profileRows ?? []) as { id: string; role: string }[]) roleById.set(p.id, p.role);
  for (const id of recipients) {
    const isPartner = roleById.get(id) === "partner";
    result.set(id, { in_app: true, push: false, email: isPartner });
  }
  const { data, error } = await client
    .from("user_notification_settings")
    .select("user_id, channels")
    .in("user_id", recipients);
  if (error) {
    logError("notification-service.lookupChannels", error);
    return result;
  }
  for (const row of data ?? []) {
    const isPartner = roleById.get(row.user_id) === "partner";
    const ch = (row.channels as Record<string, { in_app?: boolean; push?: boolean; email?: boolean }>) ?? {};
    const evCh = ch[type] ?? {};
    result.set(row.user_id, {
      in_app: evCh.in_app !== false,                              // default true
      push: evCh.push === true,                                    // default false
      email: evCh.email === undefined ? isPartner : evCh.email,    // Partner default true, sonst false
    });
  }
  return result;
}

/** Mail-Versand fuer Empfaenger die den Email-Kanal aktiv haben.
 *  Best-effort: Fehler werden geloggt, blockieren aber nicht die anderen
 *  Deliveries. Skippt komplett wenn kein RESEND_API_KEY. */
async function sendMailBatch(
  client: SupabaseClient,
  userIds: string[],
  mail: { subject: string; html: string },
) {
  if (userIds.length === 0) return;
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const { data: profiles } = await client
    .from("profiles")
    .select("id, email")
    .in("id", userIds);
  const targets = (profiles ?? []).filter((p): p is { id: string; email: string } => !!(p as { email?: string | null }).email);
  if (targets.length === 0) return;
  const { Resend } = await import("resend");
  const resend = new Resend(resendKey);
  const company = await loadCompanySettings(client);
  await Promise.all(targets.map((t) =>
    resend.emails.send({
      from: formatMailFrom(company, "noreply@eventline-basel.com"),
      to: t.email,
      subject: mail.subject,
      html: mail.html,
    }).catch((err) => logError("notification-service.mail.send", err, { to: t.email })),
  ));
}

/** Pushen an alle Subscriptions der angegebenen User. Best-effort,
 *  errors loggen aber nicht werfen. Entfernt 410-Gone-Subscriptions. */
async function sendPushBatch(
  client: SupabaseClient,
  userIds: string[],
  payload: { title: string; body?: string; url?: string; tag?: string },
) {
  if (!PUSH_ENABLED || userIds.length === 0) return;
  const { data: subs } = await client
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("user_id", userIds);
  if (!subs || subs.length === 0) return;
  const json = JSON.stringify(payload);
  const expired: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        json,
      );
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        expired.push(s.endpoint);
      } else {
        logError("notification-service.push.send", err);
      }
    }
  }));
  if (expired.length > 0) {
    await client.from("push_subscriptions").delete().in("endpoint", expired);
  }
}

/** Helper: in-app + push + optional email parallel. Alle public Service-
 *  Funktionen nutzen das statt direkt insertMany. */
async function deliver(
  client: SupabaseClient,
  recipients: string[],
  type: NotificationType,
  base: Omit<NotificationRow, "user_id" | "type">,
  mail?: { subject: string; html: string },
) {
  const unique = Array.from(new Set(recipients.filter(Boolean)));
  if (unique.length === 0) return;
  const channels = await lookupChannels(client, unique, type);
  const inAppRecipients = unique.filter((id) => channels.get(id)?.in_app);
  const pushRecipients = unique.filter((id) => channels.get(id)?.push);
  const mailRecipients = mail ? unique.filter((id) => channels.get(id)?.email) : [];
  await Promise.all([
    insertMany(client, fanOut(inAppRecipients, { type, ...base })),
    sendPushBatch(client, pushRecipients, {
      title: base.title,
      body: base.message ?? undefined,
      url: base.link ?? undefined,
      tag: type,
    }),
    mail && mailRecipients.length > 0
      ? sendMailBatch(client, mailRecipients, mail)
      : Promise.resolve(),
  ]);
}

// =============================================================
// Public API — pro Event eine Funktion
// =============================================================

interface BaseArgs {
  recipients: string[];
}

// --- TICKETS -------------------------------------------------

const TICKET_TYPE_LABEL: Record<string, string> = {
  it: "IT-Problem",
  beleg: "Beleg",
  stempel_aenderung: "Stempel-Aenderung",
  material: "Material",
};

export async function notifyTicketNew(
  client: SupabaseClient,
  args: BaseArgs & {
    ticketId: string;
    ticketNumber: number;
    ticketTitle: string;
    ticketType: string;
    byName: string;
  },
) {
  const label = TICKET_TYPE_LABEL[args.ticketType] ?? "Ticket";
  await deliver(client, args.recipients, "ticket_new", {
    title: `Neues ${label}: ${args.ticketTitle}`,
    message: `${args.byName} hat T-${args.ticketNumber} eingereicht.`,
    link: `/tickets/${args.ticketId}`,
    resource_type: "ticket",
    resource_id: args.ticketId,
  });
}

export async function notifyTicketDone(
  client: SupabaseClient,
  args: BaseArgs & {
    ticketId: string;
    ticketNumber: number;
    ticketTitle: string;
    byName: string;
  },
) {
  await deliver(client, args.recipients, "ticket_done", {
    title: `Ticket erledigt: ${args.ticketTitle}`,
    message: `${args.byName} hat T-${args.ticketNumber} geschlossen.`,
    link: `/tickets/${args.ticketId}`,
    resource_type: "ticket",
    resource_id: args.ticketId,
  });
}

export async function notifyTicketRejected(
  client: SupabaseClient,
  args: BaseArgs & {
    ticketId: string;
    ticketNumber: number;
    ticketTitle: string;
    reason: string;
    byName: string;
  },
) {
  await deliver(client, args.recipients, "ticket_rejected", {
    title: `Ticket abgelehnt: ${args.ticketTitle}`,
    message: `${args.byName} hat T-${args.ticketNumber} abgelehnt: ${args.reason}`,
    link: `/tickets/${args.ticketId}`,
    resource_type: "ticket",
    resource_id: args.ticketId,
  });
}

// --- JOBS ----------------------------------------------------

export async function notifyJobAssigned(
  client: SupabaseClient,
  args: BaseArgs & {
    jobId: string;
    jobNumber: number;
    jobTitle: string;
    byName: string;
  },
) {
  await deliver(client, args.recipients, "job_assigned", {
    title: `Auftrag zugewiesen: ${args.jobTitle}`,
    message: `${args.byName} hat dich INT-${args.jobNumber} zugewiesen.`,
    link: `/auftraege/${args.jobId}`,
    resource_type: "job",
    resource_id: args.jobId,
  });
}

// --- APPOINTMENTS --------------------------------------------

export async function notifyAppointmentNew(
  client: SupabaseClient,
  args: BaseArgs & {
    appointmentId: string;
    appointmentTitle: string;
    jobId: string;
    jobNumber: number;
    startTime: string;
    byName: string;
  },
) {
  const when = new Date(args.startTime).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  await deliver(client, args.recipients, "appointment_new", {
    title: `Neuer Termin: ${args.appointmentTitle}`,
    message: `${when} - INT-${args.jobNumber}. Eingetragen von ${args.byName}.`,
    link: `/auftraege/${args.jobId}`,
    resource_type: "appointment",
    resource_id: args.appointmentId,
  });
}

// --- TODOS ---------------------------------------------------

export async function notifyTodoAssigned(
  client: SupabaseClient,
  args: BaseArgs & {
    todoId: string;
    todoTitle: string;
    byName: string;
    urgent?: boolean;
  },
) {
  await deliver(client, args.recipients, "todo_assigned", {
    title: `${args.urgent ? "Dringend: " : ""}${args.todoTitle}`,
    message: `${args.byName} hat dir ein Todo zugewiesen.`,
    link: `/todos`,
    resource_type: "todo",
    resource_id: args.todoId,
  });
}

// --- STEMPEL-REMINDER (CRON) ---------------------------------

/** Per-User-Reminder mit Job-Kontext. Wird vom Cron alle 30 Min
 *  pro offenen time_entry erzeugt — Recipients ist ein einzelner User. */
export async function notifyStempelReminderPerEntry(
  client: SupabaseClient,
  args: {
    userId: string;
    entryId: string;
    jobLabel: string;
    endIso: string;
  },
) {
  const endStr = new Date(args.endIso).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  await deliver(client, [args.userId], "stempel_reminder", {
    title: `Stempeluhr laeuft noch: ${args.jobLabel}`,
    message: `Termin endete ${endStr} — bitte ausstempeln falls die Arbeit fertig ist.`,
    link: "/stempel",
    resource_type: "time_entry",
    resource_id: args.entryId,
  });
}

/** Generischer Stempel-Reminder ohne Job-Kontext. */
export async function notifyStempelReminder(
  client: SupabaseClient,
  args: BaseArgs & {
    sinceMin: number;
  },
) {
  await deliver(client, args.recipients, "stempel_reminder", {
    title: "Stempel laeuft noch",
    message: `Du bist seit ${args.sinceMin} Min eingestempelt — vergessen auszustempeln?`,
    link: "/stempelzeiten",
    resource_type: null,
    resource_id: null,
  });
}

// --- TODOS (taeglicher Overdue-Ping) -------------------------

export async function notifyTodoOverdue(
  client: SupabaseClient,
  args: BaseArgs & {
    todoId: string;
    title: string;
    /** YYYY-MM-DD — wird im Body als 'seit X Tagen ueberfaellig' ausgewiesen. */
    dueDateIso: string;
    daysOverdue: number;
  },
) {
  const dayWord = args.daysOverdue === 1 ? "Tag" : "Tagen";
  await deliver(client, args.recipients, "todo_overdue", {
    title: `Ueberfaelliges Todo: ${args.title}`,
    message: `Seit ${args.daysOverdue} ${dayWord} ueberfaellig (war faellig am ${args.dueDateIso}).`,
    link: "/todos",
    resource_type: "todo",
    resource_id: args.todoId,
  });
}

// --- VERTRIEB ------------------------------------------------

export async function notifyVertriebWiedervorlage(
  client: SupabaseClient,
  args: BaseArgs & {
    leadId: string;
    leadNr: number;
    firma: string;
    note: string | null;
  },
) {
  const msg = args.note
    ? `Wiedervorlage faellig fuer ${args.firma}: ${args.note}`
    : `Wiedervorlage faellig fuer ${args.firma}`;
  await deliver(client, args.recipients, "vertrieb_wiedervorlage", {
    title: `Vertrieb: ${args.firma}`,
    message: msg,
    link: `/vertrieb/${args.leadId}`,
    resource_type: "vertrieb_lead",
    resource_id: args.leadId,
  });
}

// --- SYSTEM (fallback) ---------------------------------------

export async function notifySystem(
  client: SupabaseClient,
  args: BaseArgs & {
    title: string;
    message?: string | null;
    link?: string | null;
  },
) {
  await deliver(client, args.recipients, "system", {
    title: args.title,
    message: args.message ?? null,
    link: args.link ?? null,
    resource_type: null,
    resource_id: null,
  });
}

// --- PARTNERPORTAL -------------------------------------------

interface PartnerAnfrageBaseArgs extends BaseArgs {
  jobId: string;
  jobTitle: string;
  jobStart: string | null;
  jobEnd: string | null;
  message?: string | null;
}

function partnerAnfrageDateText(start: string | null, end: string | null): string {
  if (!start) return "";
  const s = new Date(start).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
  if (!end || end === start) return s;
  const e = new Date(end).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
  return `${s} – ${e}`;
}

function partnerMailShell(headline: string, color: string, intro: string, jobTitle: string, dateText: string, extra: string | null, jobId: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const link = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://eventline-basel.com"}/partner/anfragen/${jobId}`;
  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;padding:24px;margin:0;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
  <p style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${color};margin:0 0 4px;">EVENTLINE Partner-Portal</p>
  <h1 style="margin:0 0 16px;font-size:22px;color:${color};">${headline}</h1>
  <p style="margin:0 0 16px;color:#374151;">${intro}</p>
  <div style="background:#f9fafb;border-radius:8px;padding:16px;margin-bottom:16px;">
    <p style="margin:0 0 4px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Anfrage</p>
    <p style="margin:0;font-weight:600;color:#111827;">${esc(jobTitle)}</p>
    ${dateText ? `<p style="margin:8px 0 0;font-size:13px;color:#6b7280;">${dateText}</p>` : ""}
  </div>
  ${extra ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px;margin-bottom:16px;"><p style="margin:0;color:#111827;white-space:pre-wrap;">${esc(extra)}</p></div>` : ""}
  <a href="${link}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">Anfrage im Portal öffnen</a>
  <p style="margin:24px 0 0;font-size:11px;color:#9ca3af;">Diese Mail wurde automatisch versendet. Kanäle einstellbar im Partner-Portal unter Konto → Benachrichtigungen.</p>
</div></body></html>`;
}

export async function notifyPartnerAnfrageBestaetigt(client: SupabaseClient, args: PartnerAnfrageBaseArgs) {
  const dateText = partnerAnfrageDateText(args.jobStart, args.jobEnd);
  const messageLine = args.message ? `\n\nMitteilung: ${args.message}` : "";
  await deliver(client, args.recipients, "partner_anfrage_bestaetigt", {
    title: `Anfrage bestätigt: ${args.jobTitle}`,
    message: `EVENTLINE hat deine Anfrage angenommen.${messageLine}`,
    link: `/partner/anfragen/${args.jobId}`,
    resource_type: "job",
    resource_id: args.jobId,
  }, {
    subject: `Anfrage bestätigt: ${args.jobTitle}`,
    html: partnerMailShell(
      "Anfrage bestätigt", "#00a86b",
      "EVENTLINE hat deine Anfrage angenommen und kümmert sich um die Umsetzung.",
      args.jobTitle, dateText, args.message ?? null, args.jobId,
    ),
  });
}

export async function notifyPartnerAnfrageAbgelehnt(client: SupabaseClient, args: PartnerAnfrageBaseArgs) {
  const dateText = partnerAnfrageDateText(args.jobStart, args.jobEnd);
  const messageLine = args.message ? `\n\nGrund: ${args.message}` : "";
  await deliver(client, args.recipients, "partner_anfrage_abgelehnt", {
    title: `Anfrage abgelehnt: ${args.jobTitle}`,
    message: `EVENTLINE hat deine Anfrage leider abgelehnt.${messageLine}`,
    link: `/partner/anfragen/${args.jobId}`,
    resource_type: "job",
    resource_id: args.jobId,
  }, {
    subject: `Anfrage abgelehnt: ${args.jobTitle}`,
    html: partnerMailShell(
      "Anfrage abgelehnt", "#dc2626",
      "EVENTLINE hat deine Anfrage leider abgelehnt.",
      args.jobTitle, dateText, args.message ?? null, args.jobId,
    ),
  });
}

export async function notifyPartnerTerminZugewiesen(
  client: SupabaseClient,
  args: BaseArgs & {
    jobId: string;
    jobTitle: string;
    apptTitle: string;
    apptStart: string;
    apptEnd: string | null;
    assigneeName: string;
  },
) {
  const dt = new Date(args.apptStart).toLocaleString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  await deliver(client, args.recipients, "partner_termin_zugewiesen", {
    title: `Techniker zugeteilt: ${args.jobTitle}`,
    message: `${args.assigneeName} übernimmt "${args.apptTitle}" am ${dt}.`,
    link: `/partner/anfragen/${args.jobId}`,
    resource_type: "job",
    resource_id: args.jobId,
  }, {
    subject: `Techniker zugeteilt: ${args.jobTitle}`,
    html: partnerMailShell(
      "Techniker zugeteilt", "#111827",
      `Für deine Anfrage ist jetzt ein Techniker eingeteilt: <strong>${args.assigneeName}</strong> übernimmt „${args.apptTitle}" am ${dt}.`,
      args.jobTitle, "", null, args.jobId,
    ),
  });
}
