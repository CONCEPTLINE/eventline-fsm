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

interface NotificationTypeMeta {
  icon: React.ComponentType<{ className?: string }>;
  accent: NotificationAccent;
  label: string;
}

export const NOTIFICATION_META: Record<NotificationType, NotificationTypeMeta> = {
  ticket_new:       { icon: Ticket,       accent: "blue",  label: "Neues Ticket"      },
  ticket_done:      { icon: CheckCircle2, accent: "green", label: "Ticket erledigt"   },
  ticket_rejected:  { icon: XCircle,      accent: "red",   label: "Ticket abgelehnt"  },
  job_assigned:     { icon: Briefcase,    accent: "red",   label: "Auftrag zugewiesen" },
  appointment_new:  { icon: Calendar,     accent: "blue",  label: "Neuer Termin"      },
  todo_assigned:    { icon: CheckSquare,  accent: "amber", label: "Todo zugewiesen"   },
  todo_overdue:     { icon: AlertTriangle, accent: "red",  label: "Todo ueberfaellig" },
  stempel_reminder: { icon: Clock,        accent: "green", label: "Stempel-Erinnerung" },
  vertrieb_wiedervorlage: { icon: Bell,   accent: "amber", label: "Wiedervorlage"     },
  system:           { icon: Info,         accent: "gray",  label: "System"            },
  partner_anfrage_bestaetigt: { icon: CheckCircle2, accent: "green", label: "Anfrage bestätigt" },
  partner_anfrage_abgelehnt:  { icon: XCircle,      accent: "red",   label: "Anfrage abgelehnt" },
  partner_termin_zugewiesen:  { icon: Briefcase,    accent: "blue",  label: "Techniker zugeteilt" },
};

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
