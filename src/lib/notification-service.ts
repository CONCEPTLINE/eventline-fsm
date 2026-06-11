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
import { logError } from "@/lib/log";
import type { NotificationType } from "@/types";

interface NotificationRow {
  user_id: string;
  type: NotificationType;
  title: string;
  message: string | null;
  link: string | null;
  resource_type: string | null;
  resource_id: string | null;
}

/** Low-level Insert. Funktionen unten bauen Rows und reichen sie hier
 *  durch. Insert ist best-effort: Fehler werden geloggt, nicht geworfen. */
async function insertMany(client: SupabaseClient, rows: NotificationRow[]) {
  if (rows.length === 0) return;
  const { error } = await client.from("notifications").insert(rows);
  if (error) logError("notification-service.insert", error, { count: rows.length });
}

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
  await insertMany(client, fanOut(args.recipients, {
    type: "ticket_new" as NotificationType,
    title: `Neues ${label}: ${args.ticketTitle}`,
    message: `${args.byName} hat T-${args.ticketNumber} eingereicht.`,
    link: `/tickets/${args.ticketId}`,
    resource_type: "ticket",
    resource_id: args.ticketId,
  }));
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
  await insertMany(client, fanOut(args.recipients, {
    type: "ticket_done" as NotificationType,
    title: `Ticket erledigt: ${args.ticketTitle}`,
    message: `${args.byName} hat T-${args.ticketNumber} geschlossen.`,
    link: `/tickets/${args.ticketId}`,
    resource_type: "ticket",
    resource_id: args.ticketId,
  }));
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
  await insertMany(client, fanOut(args.recipients, {
    type: "ticket_rejected" as NotificationType,
    title: `Ticket abgelehnt: ${args.ticketTitle}`,
    message: `${args.byName} hat T-${args.ticketNumber} abgelehnt: ${args.reason}`,
    link: `/tickets/${args.ticketId}`,
    resource_type: "ticket",
    resource_id: args.ticketId,
  }));
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
  await insertMany(client, fanOut(args.recipients, {
    type: "job_assigned" as NotificationType,
    title: `Auftrag zugewiesen: ${args.jobTitle}`,
    message: `${args.byName} hat dich INT-${args.jobNumber} zugewiesen.`,
    link: `/auftraege/${args.jobId}`,
    resource_type: "job",
    resource_id: args.jobId,
  }));
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
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  await insertMany(client, fanOut(args.recipients, {
    type: "appointment_new" as NotificationType,
    title: `Neuer Termin: ${args.appointmentTitle}`,
    message: `${when} - INT-${args.jobNumber}. Eingetragen von ${args.byName}.`,
    link: `/auftraege/${args.jobId}`,
    resource_type: "appointment",
    resource_id: args.appointmentId,
  }));
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
  await insertMany(client, fanOut(args.recipients, {
    type: "todo_assigned" as NotificationType,
    title: `${args.urgent ? "Dringend: " : ""}${args.todoTitle}`,
    message: `${args.byName} hat dir ein Todo zugewiesen.`,
    link: `/todos`,
    resource_type: "todo",
    resource_id: args.todoId,
  }));
}

// --- STEMPEL-REMINDER (CRON) ---------------------------------

export async function notifyStempelReminder(
  client: SupabaseClient,
  args: BaseArgs & {
    sinceMin: number;
  },
) {
  await insertMany(client, fanOut(args.recipients, {
    type: "stempel_reminder" as NotificationType,
    title: "Stempel laeuft noch",
    message: `Du bist seit ${args.sinceMin} Min eingestempelt — vergessen auszustempeln?`,
    link: "/stempelzeiten",
    resource_type: null,
    resource_id: null,
  }));
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
  await insertMany(client, fanOut(args.recipients, {
    type: "system" as NotificationType,
    title: args.title,
    message: args.message ?? null,
    link: args.link ?? null,
    resource_type: null,
    resource_id: null,
  }));
}
