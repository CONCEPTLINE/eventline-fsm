"use client";

/**
 * NotificationsBell — Trigger-Button in der Sidebar + Side-Drawer rechts.
 *
 * Vorher: kompaktes Dropdown (360px) das je nach Position des Buttons
 * irgendwo aufpoppte. Begrenzte Lesbarkeit, zu eng fuer Aktionen.
 *
 * Jetzt: Side-Drawer (Sheet) der von rechts einfaehrt, volle Hoehe,
 * ~440px breit auf Desktop, volle Breite auf Mobile. Mehr Platz fuer
 * groessere Notification-Cards, klare Sektions-Header und zukuenftig
 * Aktions-Buttons.
 *
 * Realtime-Subscription auf der notifications-Tabelle haelt die Liste
 * live via window 'realtime:notifications' Event aus dem (app)/layout.tsx.
 * RLS filtert pro User automatisch.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X as XIcon } from "lucide-react";
import { Bell, Check, CheckCheck, Inbox, Trash2, RotateCcw, CircleCheck, AlarmClock, Flame, Layers } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import {
  NOTIFICATION_META,
  ACCENT_CLASSES,
} from "@/lib/notification-meta";
import type { Notification, NotificationType } from "@/types";
import { usePermissions } from "@/lib/use-permissions";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { playNotificationSound } from "@/lib/notification-sound";

// Notif-Types die typischerweise eine User-Reaktion brauchen.
// Andere (job_assigned, ticket_done, system) sind FYI-Updates.
const ACTION_REQUIRED_TYPES = new Set<NotificationType>([
  "ticket_new",
  "ticket_rejected",
  "todo_assigned",
  "appointment_new",
  "stempel_reminder",
]);

const SNOOZE_OPTIONS = [
  { key: "1h", label: "1 Stunde", mins: 60 },
  { key: "morgen", label: "Morgen 8:00", mins: -1 }, // -1 = special "tomorrow 8am"
  { key: "1week", label: "Naechste Woche", mins: 60 * 24 * 7 },
] as const;
function computeSnoozeUntil(key: typeof SNOOZE_OPTIONS[number]["key"]): string {
  if (key === "morgen") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.toISOString();
  }
  const opt = SNOOZE_OPTIONS.find((o) => o.key === key)!;
  return new Date(Date.now() + opt.mins * 60_000).toISOString();
}

const PREVIEW_LIMIT = 50;

export function NotificationsBell() {
  const supabase = createClient();
  const router = useRouter();
  const { role } = usePermissions();
  // Techniker noch nicht freigeschaltet — Click zeigt Hinweis-Toast.
  const isLocked = role === "techniker";
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  // Default 'ungelesen': beim Oeffnen sieht man sofort was zu tun ist,
  // nicht die Erledigt-Sektion. User kann manuell auf 'Alle' wechseln —
  // wird beim erneuten Oeffnen aber wieder auf 'ungelesen' zurueckgesetzt
  // (siehe useEffect unten).
  const [filter, setFilter] = useState<"alle" | "ungelesen">("ungelesen");
  // Bei jedem Open Filter auf 'ungelesen' zuruecksetzen damit nicht ein
  // manueller 'Alle'-Wechsel zwischen den Sessions haengen bleibt.
  useEffect(() => {
    if (open) setFilter("ungelesen");
  }, [open]);
  const [unread, setUnread] = useState(0);
  const [pulse, setPulse] = useState(false);
  // Eingehende Notif als prominentes Popup oben rechts. Stack:
  // mehrere neuere Notifs werden aneinandergereiht (max 3 sichtbar).
  const [popups, setPopups] = useState<Notification[]>([]);
  // Ref auf seen-IDs damit Realtime-Inserts genau ein Mal Toast triggern
  // (sonst dispatches mehrfach pro Insert in Edge-Faellen).
  const seenIdsRef = useRef<Set<string>>(new Set());

  async function load() {
    const nowIso = new Date().toISOString();
    const [{ data }, { count }] = await Promise.all([
      supabase
        .from("notifications")
        .select("*")
        .or(`snoozed_until.is.null,snoozed_until.lt.${nowIso}`)
        .order("created_at", { ascending: false })
        .limit(PREVIEW_LIMIT),
      supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("is_read", false)
        .or(`snoozed_until.is.null,snoozed_until.lt.${nowIso}`),
    ]);
    if (data) {
      setNotifications(data as Notification[]);
      // seen-Set fuer Initial-Load fuellen damit der erste Toast nur fuer
      // echte Live-Inserts kommt, nicht fuer History-Items.
      for (const n of data as Notification[]) seenIdsRef.current.add(n.id);
    }
    setUnread(count ?? 0);
  }

  useEffect(() => {
    load();
    // Realtime: Payload analysieren. Bei echtem INSERT → Popup + Pulse + Sound.
    // Bei UPDATE/DELETE → nur load() (Drawer aktualisiert sich).
    //
    // WICHTIG: Check fuer 'isNew' VOR load() ausfuehren — sonst koennte
    // ein parallel laufendes load() die ID schon in seenIdsRef stecken
    // bevor der Check rennt.
    const handler = (event: Event) => {
      const ev = event as CustomEvent<{ eventType?: string; new?: Notification }>;
      const detail = ev.detail;
      const isNewInsert =
        detail?.eventType === "INSERT" &&
        !!detail.new &&
        !seenIdsRef.current.has(detail.new.id);
      if (isNewInsert && detail.new) {
        seenIdsRef.current.add(detail.new.id);
        // Prominentes Popup oben rechts — nur wenn Drawer zu (sonst
        // doppelte Info).
        if (!open) {
          setPopups((prev) => [detail.new!, ...prev].slice(0, 3));
        }
        // Glocke pulsiert 2s + Sound (opt-in)
        setPulse(true);
        window.setTimeout(() => setPulse(false), 2000);
        playNotificationSound();
      }
      load();
    };
    window.addEventListener("realtime:notifications", handler as EventListener);
    return () => window.removeEventListener("realtime:notifications", handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function dismissPopup(id: string) {
    setPopups((prev) => prev.filter((p) => p.id !== id));
  }
  function openFromPopup(n: Notification) {
    if (!n.is_read) markAsRead(n.id);
    dismissPopup(n.id);
    if (n.link) router.push(n.link);
  }

  async function markAsRead(id: string) {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    setUnread((prev) => Math.max(0, prev - 1));
    const { error } = await supabase.from("notifications").update({ is_read: true }).eq("id", id);
    if (error) load();
  }

  async function markAllAsRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnread(0);
    const { error } = await supabase.from("notifications").update({ is_read: true }).eq("is_read", false);
    if (error) load();
  }

  async function markAsUnread(id: string) {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: false } : n)));
    setUnread((prev) => prev + 1);
    const { error } = await supabase.from("notifications").update({ is_read: false }).eq("id", id);
    if (error) load();
  }

  async function snooze(id: string, key: typeof SNOOZE_OPTIONS[number]["key"]) {
    const until = computeSnoozeUntil(key);
    // Im UI sofort weg
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    const wasUnread = notifications.find((n) => n.id === id)?.is_read === false;
    if (wasUnread) setUnread((prev) => Math.max(0, prev - 1));
    const { error } = await supabase
      .from("notifications")
      .update({ snoozed_until: until })
      .eq("id", id);
    if (error) load();
    else {
      const opt = SNOOZE_OPTIONS.find((o) => o.key === key)!;
      toast.success(`Snoozed: ${opt.label}`);
    }
  }

  async function deleteOne(id: string) {
    const n = notifications.find((x) => x.id === id);
    setNotifications((prev) => prev.filter((x) => x.id !== id));
    if (n && !n.is_read) setUnread((prev) => Math.max(0, prev - 1));
    const { error } = await supabase.from("notifications").delete().eq("id", id);
    if (error) load();
  }

  /** Aktion-Buttons je Notification-Type. Aktuell unterstuetzt:
   *  todo_assigned -> 'Erledigt' markiert das verknuepfte Todo als done. */
  async function performAction(n: Notification, action: string) {
    if (n.type === "todo_assigned" && action === "done" && n.resource_id) {
      const { error } = await supabase
        .from("todos")
        .update({ status: "erledigt" })
        .eq("id", n.resource_id);
      if (error) {
        toast.error("Konnte Todo nicht abschliessen: " + error.message);
        return;
      }
      toast.success("Todo erledigt");
      // Notification auch direkt weg + als gelesen markiert
      await markAsRead(n.id);
    }
  }

  async function clickNotification(n: Notification) {
    if (!n.is_read) markAsRead(n.id);
    setOpen(false);
    if (n.link) router.push(n.link);
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (diffMin < 1) return "gerade eben";
    if (diffMin < 60) return `vor ${diffMin}min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `vor ${diffH}h`;
    return d.toLocaleString("de-CH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // Action-First-Gruppierung:
  //  1) Brauchen Aktion: ungelesene Notifs mit action-required-Type
  //  2) Updates: ungelesene Notifs vom FYI-Type
  //  3) Erledigt: gelesene Notifs (collapsible default zu)
  const [doneCollapsed, setDoneCollapsed] = useState(true);
  const grouped = useMemo(() => {
    const filtered = filter === "ungelesen" ? notifications.filter((n) => !n.is_read) : notifications;
    const action: Notification[] = [];
    const updates: Notification[] = [];
    const done: Notification[] = [];
    for (const n of filtered) {
      if (n.is_read) done.push(n);
      else if (ACTION_REQUIRED_TYPES.has(n.type as NotificationType)) action.push(n);
      else updates.push(n);
    }
    return [
      { key: "action", label: "Brauchen Aktion", icon: Flame, items: action, tone: "red" as const },
      { key: "updates", label: "Updates", icon: Layers, items: updates, tone: "blue" as const },
      { key: "done", label: "Erledigt", icon: Check, items: done, tone: "muted" as const, collapsible: true },
    ].filter((g) => g.items.length > 0);
  }, [notifications, filter]);

  const totalShown = grouped.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (isLocked) {
            toast.info("Diese Funktion ist noch in Bearbeitung.");
            return;
          }
          setOpen(true);
        }}
        className={`relative p-2 rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-colors ${pulse ? "animate-pulse" : ""}`}
        data-tooltip="Benachrichtigungen"
        aria-label="Benachrichtigungen"
      >
        <Bell className={`h-5 w-5 ${pulse ? "text-red-500" : ""}`} />
        {!isLocked && unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold leading-none">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
        {pulse && (
          <span className="absolute inset-0 rounded-lg bg-red-500/20 animate-ping" />
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:w-[440px] sm:max-w-[440px] p-0 flex flex-col bg-background"
        >
          {/* Header */}
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border shrink-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle className="flex items-center gap-2 text-base">
                <Bell className="h-4 w-4 text-red-500" />
                Benachrichtigungen
                {unread > 0 && (
                  <span className="inline-flex items-center justify-center px-1.5 h-5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 text-[11px] font-semibold tabular-nums">
                    {unread}
                  </span>
                )}
              </SheetTitle>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 p-0.5 rounded-lg bg-muted">
              <button
                type="button"
                onClick={() => setFilter("alle")}
                className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
                  filter === "alle" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Alle ({notifications.length})
              </button>
              <button
                type="button"
                onClick={() => setFilter("ungelesen")}
                className={`flex-1 h-8 rounded-md text-xs font-medium transition-colors ${
                  filter === "ungelesen" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Ungelesen ({unread})
              </button>
            </div>

            {unread > 0 && (
              <button
                type="button"
                onClick={markAllAsRead}
                className="self-end flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <CheckCheck className="h-3 w-3" />
                Alle als gelesen markieren
              </button>
            )}
          </SheetHeader>

          {/* Body */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {totalShown === 0 ? (
              <div className="flex flex-col items-center justify-center text-center text-muted-foreground py-16 px-6 gap-3">
                <Inbox className="h-10 w-10 opacity-40" />
                <p className="text-sm">
                  {filter === "ungelesen" ? "Alles gelesen!" : "Keine Benachrichtigungen."}
                </p>
                {filter === "ungelesen" && (
                  <button
                    type="button"
                    onClick={() => setFilter("alle")}
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    Frueher angezeigte anschauen
                  </button>
                )}
              </div>
            ) : (
              <div className="pb-4">
                {grouped.map((group) => {
                  const SectionIcon = group.icon;
                  const collapsed = group.collapsible && doneCollapsed;
                  return (
                  <div key={group.key}>
                    <button
                      type="button"
                      onClick={group.collapsible ? () => setDoneCollapsed((v) => !v) : undefined}
                      className={`w-full sticky top-0 z-10 bg-background/95 backdrop-blur px-5 pt-3 pb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider font-semibold border-b border-border/50 transition-colors ${
                        group.tone === "red" ? "text-red-600 dark:text-red-400" :
                        group.tone === "blue" ? "text-blue-600 dark:text-blue-400" :
                        "text-muted-foreground/80"
                      } ${group.collapsible ? "hover:bg-muted/30 cursor-pointer" : ""}`}
                    >
                      <SectionIcon className="h-3 w-3" />
                      {group.label}
                      <span className="ml-1 px-1.5 py-0 rounded-full bg-foreground/10 text-foreground/80 tabular-nums">
                        {group.items.length}
                      </span>
                      {group.collapsible && (
                        <span className="ml-auto text-muted-foreground/60">{collapsed ? "▼" : "▲"}</span>
                      )}
                    </button>
                    {!collapsed && (
                      <div>
                        {group.items.map((n) => {
                          const meta = NOTIFICATION_META[(n.type as NotificationType) ?? "system"] ?? NOTIFICATION_META.system;
                          const Icon = meta.icon;
                          const bundleCount = n.bundle_count ?? 1;
                          return (
                            <div
                              key={n.id}
                              className={`group relative px-5 py-3 border-b border-border/40 hover:bg-muted/40 transition-colors ${
                                !n.is_read ? "bg-blue-500/[0.04]" : ""
                              }`}
                            >
                              <div className="flex items-start gap-3">
                                <div className={`relative w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${ACCENT_CLASSES[meta.accent]}`}>
                                  <Icon className="h-4 w-4" />
                                  {bundleCount > 1 && (
                                    <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-foreground text-background text-[9px] font-bold leading-none">
                                      {bundleCount}
                                    </span>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => clickNotification(n)}
                                  className="flex-1 min-w-0 text-left"
                                >
                                  <div className="flex items-start gap-2">
                                    <p className={`text-sm leading-tight ${!n.is_read ? "font-semibold" : ""}`}>{n.title}</p>
                                    {!n.is_read && <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 shrink-0" />}
                                  </div>
                                  {n.message && (
                                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{n.message}</p>
                                  )}
                                  <p className="text-[10px] text-muted-foreground/70 mt-1.5">{formatTime(n.created_at)}</p>
                                </button>
                                {/* Hover-Action-Strip rechts */}
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity self-start">
                                  {!n.is_read && (
                                    <SnoozeMenu onPick={(key) => snooze(n.id, key)} />
                                  )}
                                  {n.is_read ? (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); markAsUnread(n.id); }}
                                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                                      data-tooltip="Als ungelesen"
                                      aria-label="Als ungelesen markieren"
                                    >
                                      <RotateCcw className="h-3.5 w-3.5" />
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); markAsRead(n.id); }}
                                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                                      data-tooltip="Als gelesen"
                                      aria-label="Als gelesen markieren"
                                    >
                                      <Check className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); deleteOne(n.id); }}
                                    className="p-1 rounded text-muted-foreground hover:text-red-500 hover:bg-red-500/10"
                                    data-tooltip="Loeschen"
                                    aria-label="Loeschen"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>

                              {/* Type-spezifische Aktion-Buttons unter dem Body */}
                              {n.type === "todo_assigned" && n.resource_id && (
                                <div className="flex gap-2 mt-2 ml-12">
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); performAction(n, "done"); }}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-green-500/15 text-green-700 dark:text-green-300 hover:bg-green-500/25 transition-colors"
                                  >
                                    <CircleCheck className="h-3 w-3" />
                                    Erledigt
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer — nur Einstellungen-Link. Vollansichts-Seite wurde
              entfernt, da sie keine relevanten Features ueber den Drawer
              hinaus hatte. */}
          <div className="px-5 py-3 border-t border-border bg-card/40 shrink-0 flex items-center justify-end">
            <Link
              href="/mein-konto?tab=benachrichtigungen"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Einstellungen →
            </Link>
          </div>
        </SheetContent>
      </Sheet>

      {/* Prominentes Popup oben rechts — slide-in animation, max 3
          gleichzeitig. Auto-dismiss nach 7s, click oeffnet Link. */}
      {typeof window !== "undefined" && popups.length > 0 && createPortal(
        <div className="fixed top-4 right-4 z-[1500] flex flex-col gap-2 max-w-sm w-[calc(100%-2rem)] sm:w-96 pointer-events-none">
          {popups.map((n) => (
            <NotificationPopupCard
              key={n.id}
              notif={n}
              onOpen={() => openFromPopup(n)}
              onDismiss={() => dismissPopup(n.id)}
            />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Slide-in Popup-Card. Self-dismiss nach 7s, fade-out beim Unmount. */
function NotificationPopupCard({
  notif, onOpen, onDismiss,
}: {
  notif: Notification;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const meta = NOTIFICATION_META[(notif.type as NotificationType) ?? "system"] ?? NOTIFICATION_META.system;
  const Icon = meta.icon;
  useEffect(() => {
    const t = window.setTimeout(onDismiss, 7000);
    return () => window.clearTimeout(t);
  }, [onDismiss]);
  return (
    <div className="pointer-events-auto relative animate-[slide-in-right_220ms_ease-out] rounded-xl bg-card border border-border shadow-2xl overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left p-4 flex items-start gap-3 hover:bg-muted/40 transition-colors"
      >
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${ACCENT_CLASSES[meta.accent]}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight">{notif.title}</p>
          {notif.message && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{notif.message}</p>
          )}
          {notif.link && (
            <p className="text-[10px] text-red-600 dark:text-red-400 font-semibold mt-2 uppercase tracking-wider">Öffnen →</p>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        className="absolute top-2 right-2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60"
        aria-label="Schliessen"
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
      {/* Progress-Bar als Auto-Dismiss-Anzeige */}
      <div className="h-0.5 bg-red-500/30 overflow-hidden">
        <div className="h-full bg-red-500 animate-[popup-countdown_7s_linear]" />
      </div>
    </div>
  );
}

/** Snooze-Submenu: kleines Popover mit 3 Optionen.
 *  Positioniert relativ zum Hover-Action-Strip ohne overflow-Probleme. */
function SnoozeMenu({ onPick }: { onPick: (key: typeof SNOOZE_OPTIONS[number]["key"]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
        data-tooltip="Snooze"
        aria-label="Snooze"
      >
        <AlarmClock className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[80]" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="absolute right-0 top-7 z-[90] w-40 rounded-lg border border-border bg-card shadow-lg overflow-hidden">
            {SNOOZE_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen(false); onPick(o.key); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors flex items-center gap-2"
              >
                <AlarmClock className="h-3 w-3 text-muted-foreground" />
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
