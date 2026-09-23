// Notification-Meta — eine Stelle die jeden Notification-Type auf
// Icon, Akzent-Farbe und Label mappt. Gleicher Pattern wie wir's
// fuer Ticket-Types in der Tickets-Page nutzen.
//
// App-weite Farb-Konvention:
//   blue   = "neue Aktivitaet" (offen, in-progress)
//   green  = "positiv abgeschlossen" (erledigt, OK)
//   red    = "negativ" (abgelehnt, Fehler, Stornierung)
//   amber  = "Aufmerksamkeit/Warning" (z.B. Beleg/Buchhaltung-Ping)
//   purple = "IT/Tech"
//   gray   = "System/Neutral"

import { Ticket, CheckCircle2, XCircle, Info, Briefcase, Calendar, CheckSquare, Clock, Bell, AlertTriangle } from "lucide-react";
import type { NotificationType } from "@/types";

export type NotificationAccent = "blue" | "green" | "red" | "amber" | "purple" | "gray";

/** Wer einen Notification-Typ empfaengt: interne Mitarbeiter, Portal-Partner
 *  oder beide (z.B. system). Steuert, in welcher Einstellungs-Matrix der Typ
 *  auftaucht — Einstellungen → Benachrichtigungen (intern) bzw. die
 *  Partner-Konto-Karte (partner). */
export type NotificationAudience = "intern" | "partner" | "beide";

interface NotificationTypeMeta {
  icon: React.ComponentType<{ className?: string }>;
  accent: NotificationAccent;
  label: string;
  audience: NotificationAudience;
  /** Erscheint der Typ in der Kanal-Matrix (an/aus pro Kanal)? */
  configurable: boolean;
  /** Beschreibung in der Einstellungs-Matrix. */
  description: string;
  /** Abweichendes Label/Beschreibung in der Partner-Matrix (nur audience
   *  "beide" — z.B. "system" liest sich fuer Partner anders). */
  partnerLabel?: string;
  partnerDescription?: string;
}

export const NOTIFICATION_META: Record<NotificationType, NotificationTypeMeta> = {
  ticket_new:       { icon: Ticket,       accent: "blue",  label: "Neues Ticket",      audience: "intern", configurable: true, description: "Ein Mitarbeiter reicht ein neues Ticket ein (Admin)" },
  ticket_done:      { icon: CheckCircle2, accent: "green", label: "Ticket erledigt",   audience: "intern", configurable: true, description: "Dein Ticket wurde erledigt" },
  ticket_rejected:  { icon: XCircle,      accent: "red",   label: "Ticket abgelehnt",  audience: "intern", configurable: true, description: "Dein Ticket wurde abgelehnt" },
  job_assigned:     { icon: Briefcase,    accent: "red",   label: "Auftrag zugewiesen", audience: "intern", configurable: true, description: "Du wurdest einem Auftrag zugewiesen" },
  job_overdue:      { icon: AlertTriangle, accent: "red",  label: "Auftrag überfällig", audience: "intern", configurable: true, description: "Ein Auftrag ist über sein Enddatum hinaus nicht abgeschlossen" },
  appointment_new:  { icon: Calendar,     accent: "blue",  label: "Neuer Termin",      audience: "intern", configurable: true, description: "Ein Termin wurde dir eingetragen" },
  todo_assigned:    { icon: CheckSquare,  accent: "amber", label: "Todo zugewiesen",   audience: "intern", configurable: true, description: "Du hast ein neues Todo bekommen" },
  todo_overdue:     { icon: AlertTriangle, accent: "red",  label: "Todo überfällig",   audience: "intern", configurable: true, description: "Ein Todo ist über sein Fälligkeitsdatum hinaus offen" },
  stempel_reminder: { icon: Clock,        accent: "green", label: "Stempel-Erinnerung", audience: "intern", configurable: true, description: "Du bist noch eingestempelt (Cron alle 30 Min)" },
  vertrieb_wiedervorlage: { icon: Bell,   accent: "amber", label: "Wiedervorlage",     audience: "intern", configurable: true, description: "Die Wiedervorlage eines Vertriebs-Leads ist fällig" },
  system:           { icon: Info,         accent: "gray",  label: "System",            audience: "beide",  configurable: true, description: "Allgemeine System-Nachrichten", partnerLabel: "System-Nachrichten", partnerDescription: "Allgemeine Nachrichten von EVENTLINE (z.B. Wartungen, Neuerungen)" },
  partner_anfrage_bestaetigt: { icon: CheckCircle2, accent: "green", label: "Anfrage bestätigt", audience: "partner", configurable: true, description: "EVENTLINE nimmt deine Anfrage an" },
  partner_anfrage_abgelehnt:  { icon: XCircle,      accent: "red",   label: "Anfrage abgelehnt", audience: "partner", configurable: true, description: "EVENTLINE lehnt deine Anfrage ab (mit Begründung)" },
  partner_termin_zugewiesen:  { icon: Briefcase,    accent: "blue",  label: "Techniker zugeteilt", audience: "partner", configurable: true, description: "Ein Techniker wurde einem deiner Termine zugeteilt" },
};

/** Zeile fuer die Kanal-Matrizen (Einstellungen bzw. Partner-Konto). */
export interface NotificationEventDef {
  type: NotificationType;
  label: string;
  description: string;
}

/**
 * Leitet die konfigurierbaren Typen fuer eine Zielgruppe aus NOTIFICATION_META
 * ab — die EINE Quelle statt eigener Arrays in den Komponenten (die drifteten:
 * job_overdue/todo_overdue/vertrieb_wiedervorlage fehlten in der Matrix und
 * waren damit nicht abschaltbar). Reihenfolge: erst die eigenen Typen der
 * Zielgruppe (Registry-Reihenfolge), dann die geteilten ("beide", z.B. system).
 */
export function configurableNotificationEvents(audience: "intern" | "partner"): NotificationEventDef[] {
  const types = Object.keys(NOTIFICATION_META) as NotificationType[];
  const pick = (want: NotificationAudience) =>
    types.filter((t) => NOTIFICATION_META[t].configurable && NOTIFICATION_META[t].audience === want);
  return [...pick(audience), ...pick("beide")].map((t) => {
    const m = NOTIFICATION_META[t];
    return audience === "partner"
      ? { type: t, label: m.partnerLabel ?? m.label, description: m.partnerDescription ?? m.description }
      : { type: t, label: m.label, description: m.description };
  });
}

// Tailwind-Klassen pro Akzent — Bubble-Style (rounded-md mit getoenter
// Background + Akzent-Text). Identisch zum Ticket-TYPE_META-Pattern auf
// /tickets damit visuell konsistent.
export const ACCENT_CLASSES: Record<NotificationAccent, string> = {
  blue:   "bg-blue-50    dark:bg-blue-500/15    text-blue-600    dark:text-blue-400",
  green:  "bg-green-50   dark:bg-green-500/15   text-green-600   dark:text-green-400",
  red:    "bg-red-50     dark:bg-red-500/15     text-red-600     dark:text-red-400",
  amber:  "bg-amber-50   dark:bg-amber-500/15   text-amber-600   dark:text-amber-400",
  purple: "bg-purple-50  dark:bg-purple-500/15  text-purple-600  dark:text-purple-400",
  gray:   "bg-muted                              text-muted-foreground",
};

// Zeit-Bucket fuer eine Notification basierend auf created_at — fuer
// die Gruppierung im Bell-Dropdown und auf der /benachrichtigungen-Page.
export function timeBucket(iso: string): "heute" | "gestern" | "diese_woche" | "aelter" {
  const created = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  // Tag-Vergleich auf lokaler TZ (nicht UTC) damit "heute" auch nach
  // Mitternacht stimmt.
  const sameDay = created.toDateString() === now.toDateString();
  if (sameDay) return "heute";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (created.toDateString() === yesterday.toDateString()) return "gestern";
  if (diffDays < 7) return "diese_woche";
  return "aelter";
}

export const TIME_BUCKET_LABEL: Record<ReturnType<typeof timeBucket>, string> = {
  heute: "Heute",
  gestern: "Gestern",
  diese_woche: "Diese Woche",
  aelter: "Älter",
};
