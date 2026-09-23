"use client";

/**
 * Benachrichtigungs-Einstellungen pro User.
 *
 * Matrix Event × Kanal: pro Event-Typ kann der User pro Kanal an/aus
 * setzen. Default wenn nichts gespeichert: in_app=true, email=false,
 * push=false (= aktuelles App-Verhalten).
 *
 * Quiet Hours: Push-spezifisch (kommt mit Phase 5 Web-Push). In-App
 * Notifications werden immer geschrieben damit die Historie komplett
 * bleibt.
 *
 * Autosave: Toggle aendert -> sofort upsert in DB, kein Save-Button.
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { Bell, Mail, Smartphone, Clock, Volume2 } from "lucide-react";
import { isSoundEnabled, setSoundEnabled, playNotificationSound } from "@/lib/notification-sound";
import { configurableNotificationEvents } from "@/lib/notification-meta";
import type { NotificationType } from "@/types";

interface ChannelSet {
  in_app?: boolean;
  email?: boolean;
  push?: boolean;
}
type Channels = Partial<Record<NotificationType, ChannelSet>>;

interface Settings {
  channels: Channels;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
}

const DEFAULT_SETTINGS: Settings = {
  channels: {},
  quiet_hours_enabled: false,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
};

/** Event-Zeilen fuer die Matrix-UI — abgeleitet aus NOTIFICATION_META
 *  (Single Source of Truth) statt eines eigenen Arrays. Damit tauchen
 *  auch job_overdue / todo_overdue / vertrieb_wiedervorlage auf und sind
 *  abschaltbar (Audit-Befund: die waren vorher nicht konfigurierbar). */
const EVENTS = configurableNotificationEvents("intern");

const CHANNELS: { key: "in_app" | "email" | "push"; label: string; icon: typeof Bell; enabled: boolean; tooltip?: string }[] = [
  { key: "in_app", label: "In-App",  icon: Bell,        enabled: true  },
  { key: "email",  label: "E-Mail",  icon: Mail,        enabled: false, tooltip: "Folgt in einer nächsten Phase" },
  { key: "push",   label: "Push",    icon: Smartphone,  enabled: true  },
];

function effectiveChannel(channels: Channels, type: NotificationType, key: "in_app" | "email" | "push"): boolean {
  const ev = channels[type];
  if (!ev || ev[key] === undefined) {
    // Opt-out-Default: alles aktiv. Migration 217 legt beim ersten Login
    // eine Row mit allen Kanaelen an; dieser Fallback traegt den Fall in
    // dem eine Row (noch) fehlt oder ein neuer NotificationType noch nicht
    // im Blob steht.
    return true;
  }
  return Boolean(ev[key]);
}

export function BenachrichtigungenTab() {
  const supabase = createClient();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      setUserId(user.id);
      const { data } = await supabase
        .from("user_notification_settings")
        .select("channels, quiet_hours_enabled, quiet_hours_start, quiet_hours_end")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) {
        setSettings({
          channels: (data.channels as Channels) ?? {},
          quiet_hours_enabled: data.quiet_hours_enabled,
          quiet_hours_start: (data.quiet_hours_start ?? "22:00").slice(0, 5),
          quiet_hours_end: (data.quiet_hours_end ?? "07:00").slice(0, 5),
        });
      }
      setLoading(false);
    })();
  }, [supabase]);

  async function persist(next: Settings) {
    if (!userId) return;
    setSaving(true);
    const { error } = await supabase
      .from("user_notification_settings")
      .upsert({
        user_id: userId,
        channels: next.channels,
        quiet_hours_enabled: next.quiet_hours_enabled,
        quiet_hours_start: next.quiet_hours_start + ":00",
        quiet_hours_end: next.quiet_hours_end + ":00",
      }, { onConflict: "user_id" });
    setSaving(false);
    if (error) {
      toast.error("Speichern fehlgeschlagen: " + error.message);
      return;
    }
  }

  function toggleChannel(type: NotificationType, key: "in_app" | "email" | "push") {
    const current = effectiveChannel(settings.channels, type, key);
    const ev = settings.channels[type] ?? {};
    const next: Settings = {
      ...settings,
      channels: {
        ...settings.channels,
        [type]: { ...ev, [key]: !current },
      },
    };
    setSettings(next);
    persist(next);
  }

  function setQuietHoursEnabled(enabled: boolean) {
    const next = { ...settings, quiet_hours_enabled: enabled };
    setSettings(next);
    persist(next);
  }

  function setQuietHoursTime(field: "start" | "end", value: string) {
    const next = {
      ...settings,
      [field === "start" ? "quiet_hours_start" : "quiet_hours_end"]: value,
    };
    setSettings(next);
    persist(next);
  }

  // Alle aus / Alle an Convenience (in_app-Spalte)
  const allInAppOn = useMemo(
    () => EVENTS.every((e) => effectiveChannel(settings.channels, e.type, "in_app")),
    [settings.channels]
  );

  function setAllInApp(value: boolean) {
    const next: Settings = {
      ...settings,
      channels: { ...settings.channels },
    };
    for (const e of EVENTS) {
      next.channels[e.type] = { ...(next.channels[e.type] ?? {}), in_app: value };
    }
    setSettings(next);
    persist(next);
  }

  if (loading) return <p className="text-sm text-muted-foreground">Laedt…</p>;

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Sound + Push */}
      <SoundToggleCard />
      <PushSubscriptionCard />

      {/* Intro */}
      <div className="text-sm text-muted-foreground">
        Steuere pro Ereignistyp welcher Kanal genutzt wird. Änderungen werden automatisch gespeichert.
        {saving && <span className="ml-2 text-xs text-muted-foreground/70">(Speichert…)</span>}
      </div>

      {/* Matrix */}
      <Card className="bg-card">
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Ereignis</th>
                {CHANNELS.map((c) => (
                  <th key={c.key} className="text-center px-4 py-3 font-semibold w-24">
                    <div className="flex flex-col items-center gap-1">
                      <c.icon className={`h-4 w-4 ${c.enabled ? "" : "opacity-40"}`} />
                      <span className={`text-[10px] uppercase tracking-wider ${c.enabled ? "" : "opacity-40"}`}>{c.label}</span>
                    </div>
                  </th>
                ))}
              </tr>
              <tr className="border-b border-border bg-muted/20">
                <td className="px-4 py-2 text-[11px] text-muted-foreground">
                  <button type="button" onClick={() => setAllInApp(!allInAppOn)} className="hover:text-foreground transition-colors">
                    {allInAppOn ? "Alle aus" : "Alle an"}
                  </button>
                </td>
                {CHANNELS.map((c) => (
                  <td key={c.key} className="px-4 py-2 text-center text-[10px] text-muted-foreground">
                    {!c.enabled && <span data-tooltip={c.tooltip}>noch nicht</span>}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENTS.map((e) => (
                <tr key={e.type} className="border-b border-border/40 last:border-b-0 hover:bg-muted/20">
                  <td className="px-4 py-3 align-top">
                    <p className="font-medium">{e.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{e.description}</p>
                  </td>
                  {CHANNELS.map((c) => (
                    <td key={c.key} className="px-4 py-3 text-center">
                      <Toggle
                        value={effectiveChannel(settings.channels, e.type, c.key)}
                        onChange={() => toggleChannel(e.type, c.key)}
                        disabled={!c.enabled}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Quiet Hours */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="font-medium text-sm">Stille Stunden</p>
                <p className="text-xs text-muted-foreground">Wird mit Push-Benachrichtigungen aktiv (Phase 5). In-App-Nachrichten werden trotzdem gespeichert.</p>
              </div>
            </div>
            <Toggle value={settings.quiet_hours_enabled} onChange={() => setQuietHoursEnabled(!settings.quiet_hours_enabled)} />
          </div>
          {settings.quiet_hours_enabled && (
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/60">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Von</label>
                <input
                  type="time"
                  value={settings.quiet_hours_start}
                  onChange={(e) => setQuietHoursTime("start", e.target.value)}
                  className="mt-1 w-full h-9 px-3 text-sm rounded-lg border border-border bg-background"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Bis</label>
                <input
                  type="time"
                  value={settings.quiet_hours_end}
                  onChange={(e) => setQuietHoursTime("end", e.target.value)}
                  className="mt-1 w-full h-9 px-3 text-sm rounded-lg border border-border bg-background"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Sound-Toggle: kurzer Ding-Sound bei eingehenden Notifications.
 *  Einstellung ist Geraete-lokal (localStorage), nicht servergespeichert. */
function SoundToggleCard() {
  const [enabled, setEnabledState] = useState(true);
  useEffect(() => { setEnabledState(isSoundEnabled()); }, []);
  function toggle() {
    const next = !enabled;
    setEnabledState(next);
    setSoundEnabled(next);
    if (next) playNotificationSound();
  }
  return (
    <Card className="bg-card">
      <CardContent className="p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/15 text-blue-600 dark:text-blue-400">
            <Volume2 className="h-4 w-4" />
          </div>
          <div>
            <p className="font-medium text-sm">Sound bei neuer Benachrichtigung</p>
            <p className="text-xs text-muted-foreground">Kurzer Hinweiston wenn die App geöffnet ist. Pro Gerät einstellbar.</p>
          </div>
        </div>
        <Toggle value={enabled} onChange={toggle} />
      </CardContent>
    </Card>
  );
}

/** Push-Subscription-Verwaltung: Permission-Status, Aktivieren/Abmelden,
 *  pro-Geraet-Liste mit Entfernen-Button. */
function PushSubscriptionCard() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPermission("unsupported");
      return;
    }
    setPermission(Notification.permission);
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub));
  }, []);

  async function subscribe() {
    if (!vapidKey) {
      toast.error("VAPID-Schlüssel ist auf dem Server nicht konfiguriert.");
      return;
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") { setBusy(false); return; }
      const reg = await navigator.serviceWorker.ready;
      // Cast nach BufferSource — TS-Lib-Mismatch zwischen Uint8Array<ArrayBufferLike>
      // und dem PushManager-applicationServerKey-Typ. Funktional korrekt.
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });
      const res = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? "Subscribe fehlgeschlagen");
      setSubscribed(true);
      toast.success("Push-Benachrichtigungen aktiviert");
    } catch (e) {
      toast.error("Aktivierung fehlgeschlagen: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/notifications/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      toast.success("Push deaktiviert");
    } catch (e) {
      toast.error("Deaktivierung fehlgeschlagen: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (permission === "unsupported") {
    return (
      <Card className="bg-card">
        <CardContent className="p-4 text-xs text-muted-foreground">
          Push-Benachrichtigungen werden in diesem Browser nicht unterstuetzt.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card">
      <CardContent className="p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-red-500/15 text-red-600 dark:text-red-400">
            <Smartphone className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">Push auf diesem Gerät</p>
            <p className="text-xs text-muted-foreground">
              {permission === "denied"
                ? "Im Browser blockiert — Permission in den Browser-Settings zurücksetzen."
                : subscribed
                  ? "Aktiv. Du bekommst System-Benachrichtigungen auch wenn die App geschlossen ist."
                  : "Nicht aktiviert. Aktivieren um auch ohne offene App benachrichtigt zu werden."}
            </p>
          </div>
        </div>
        {permission !== "denied" && (
          subscribed
            ? <button type="button" onClick={unsubscribe} disabled={busy} className="kasten kasten-muted text-xs">Deaktivieren</button>
            : <button type="button" onClick={subscribe} disabled={busy} className="kasten kasten-red text-xs">Aktivieren</button>
        )}
      </CardContent>
    </Card>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChange}
      role="switch"
      aria-checked={value}
      disabled={disabled}
      className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        disabled
          ? "bg-foreground/10 cursor-not-allowed opacity-40"
          : value ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"
      }`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}
