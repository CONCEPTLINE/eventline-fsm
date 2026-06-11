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

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, Check, CheckCheck, Inbox } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import {
  NOTIFICATION_META,
  ACCENT_CLASSES,
  timeBucket,
  TIME_BUCKET_LABEL,
} from "@/lib/notification-meta";
import type { Notification, NotificationType } from "@/types";
import { usePermissions } from "@/lib/use-permissions";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const PREVIEW_LIMIT = 50;

export function NotificationsBell() {
  const supabase = createClient();
  const router = useRouter();
  const { role } = usePermissions();
  // Techniker noch nicht freigeschaltet — Click zeigt Hinweis-Toast.
  const isLocked = role === "techniker";
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"alle" | "ungelesen">("alle");
  const [unread, setUnread] = useState(0);

  async function load() {
    const [{ data }, { count }] = await Promise.all([
      supabase
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(PREVIEW_LIMIT),
      supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("is_read", false),
    ]);
    if (data) setNotifications(data as Notification[]);
    setUnread(count ?? 0);
  }

  useEffect(() => {
    load();
    const handler = () => load();
    window.addEventListener("realtime:notifications", handler);
    return () => window.removeEventListener("realtime:notifications", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const grouped = useMemo(() => {
    const filtered = filter === "ungelesen" ? notifications.filter((n) => !n.is_read) : notifications;
    const buckets: Record<string, Notification[]> = { heute: [], gestern: [], diese_woche: [], aelter: [] };
    for (const n of filtered) buckets[timeBucket(n.created_at)].push(n);
    return [
      { key: "heute", items: buckets.heute },
      { key: "gestern", items: buckets.gestern },
      { key: "diese_woche", items: buckets.diese_woche },
      { key: "aelter", items: buckets.aelter },
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
        className="relative p-2 rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-colors"
        data-tooltip="Benachrichtigungen"
        aria-label="Benachrichtigungen"
      >
        <Bell className="h-5 w-5" />
        {!isLocked && unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold leading-none">
            {unread > 9 ? "9+" : unread}
          </span>
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
                {grouped.map((group) => (
                  <div key={group.key}>
                    <div className="sticky top-0 z-10 bg-background/95 backdrop-blur px-5 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/80 border-b border-border/50">
                      {TIME_BUCKET_LABEL[group.key as keyof typeof TIME_BUCKET_LABEL]}
                    </div>
                    <div>
                      {group.items.map((n) => {
                        const meta = NOTIFICATION_META[(n.type as NotificationType) ?? "system"] ?? NOTIFICATION_META.system;
                        const Icon = meta.icon;
                        return (
                          <div
                            key={n.id}
                            className={`group relative px-5 py-3 border-b border-border/40 hover:bg-muted/40 transition-colors flex items-start gap-3 ${
                              !n.is_read ? "bg-blue-500/[0.04]" : ""
                            }`}
                          >
                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${ACCENT_CLASSES[meta.accent]}`}>
                              <Icon className="h-4 w-4" />
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
                            {!n.is_read && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); markAsRead(n.id); }}
                                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 self-start"
                                data-tooltip="Als gelesen markieren"
                                aria-label="Als gelesen markieren"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-border bg-card/40 shrink-0 flex items-center justify-between">
            <Link
              href="/benachrichtigungen"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Vollansicht oeffnen →
            </Link>
            <Link
              href="/einstellungen?tab=benachrichtigungen"
              onClick={() => setOpen(false)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Einstellungen
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
