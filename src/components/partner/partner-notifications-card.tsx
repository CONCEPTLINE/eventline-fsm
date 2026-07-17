"use client";

/**
 * Partner-Notifications-Card (Konto-Seite Partnerportal).
 *
 * 1. Push-Aktivierung fuer das aktuelle Geraet (nur einmal noetig).
 * 2. Matrix pro Event × Kanal (E-Mail, Push) — Partner steuert selbst
 *    welche Events er wo bekommt. Speichert in user_notification_settings
 *    (bestehende Kanal-Matrix, die alle Notification-Sender in der App
 *    eh schon respektieren).
 *
 * Bewusst OHNE In-App-Spalte — das Partnerportal ist so schlank, die
 * Bell-Historie ist dort kein primaerer Kanal.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Bell, Mail, Smartphone } from "lucide-react";
import { toast } from "sonner";
import type { NotificationType } from "@/types";

// Fuer Partner relevante Notification-Types. Wenn spaeter neue Events
// dazukommen (z.B. 'partner_anfrage_status'), hier ergaenzen.
const PARTNER_EVENTS: { type: NotificationType; label: string; description: string }[] = [
  { type: "appointment_new", label: "Neuer Termin", description: "An deiner Location wurde ein neuer Termin eingetragen" },
  { type: "system",          label: "System-Nachrichten", description: "Allgemeine Nachrichten von EVENTLINE (z.B. Wartungen, Neuerungen)" },
];

type Channel = "email" | "push";
type ChannelSet = Partial<Record<Channel, boolean>>;
type Channels = Partial<Record<NotificationType, ChannelSet>>;

function effectiveChannel(channels: Channels, type: NotificationType, key: Channel): boolean {
  const ev = channels[type];
  if (!ev || ev[key] === undefined) {
    // Default: E-Mail an (klassischer Kanal), Push aus (opt-in via Aktivierung).
    return key === "email";
  }
  return Boolean(ev[key]);
}

export function PartnerNotificationsCard() {
  const supabase = createClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channels>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }
      setUserId(user.id);
      const { data } = await supabase
        .from("user_notification_settings")
        .select("channels")
        .eq("user_id", user.id)
        .maybeSingle();
      setChannels((data?.channels as Channels) ?? {});
      setLoading(false);
    })();
  }, [supabase]);

  async function persist(next: Channels) {
    if (!userId) return;
    setSaving(true);
    const { error } = await supabase
      .from("user_notification_settings")
      .upsert({ user_id: userId, channels: next }, { onConflict: "user_id" });
    setSaving(false);
    if (error) toast.error("Speichern fehlgeschlagen: " + error.message);
  }

  function toggle(type: NotificationType, key: Channel) {
    const current = effectiveChannel(channels, type, key);
    const ev = channels[type] ?? {};
    const next: Channels = { ...channels, [type]: { ...ev, [key]: !current } };
    setChannels(next);
    void persist(next);
  }

  return (
    <Card className="bg-card">
      <CardContent className="p-0">
        <div className="p-4 border-b border-border flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-muted-foreground">Benachrichtigungen</h2>
          {saving && <span className="ml-auto text-[10px] text-muted-foreground/70">Speichert…</span>}
        </div>

        {/* Push-Aktivierung — Voraussetzung damit Push-Toggles unten wirken. */}
        <div className="p-4 border-b border-border">
          <PushActivationRow />
        </div>

        {/* Event × Kanal-Matrix */}
        {loading ? (
          <p className="p-4 text-xs text-muted-foreground">Lädt…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Ereignis</th>
                  <th className="text-center px-4 py-2.5 w-24">
                    <div className="flex flex-col items-center gap-1">
                      <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">E-Mail</span>
                    </div>
                  </th>
                  <th className="text-center px-4 py-2.5 w-24">
                    <div className="flex flex-col items-center gap-1">
                      <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Push</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {PARTNER_EVENTS.map((e) => (
                  <tr key={e.type} className="border-b border-border/40 last:border-b-0">
                    <td className="px-4 py-3 align-top">
                      <p className="font-medium text-sm">{e.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{e.description}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Toggle
                        value={effectiveChannel(channels, e.type, "email")}
                        onChange={() => toggle(e.type, "email")}
                      />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Toggle
                        value={effectiveChannel(channels, e.type, "push")}
                        onChange={() => toggle(e.type, "push")}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-2.5 text-[11px] text-muted-foreground border-t border-border">
              E-Mails gehen an deine hinterlegte Adresse. Push nur auf Geräten die oben aktiviert sind.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Push-Aktivierung fuer das aktuelle Geraet (unabhaengig von Event-Matrix).
 *  Ohne Aktivierung feuert Push nicht — auch wenn ein Event-Toggle an ist. */
function PushActivationRow() {
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
      toast.error("VAPID-Schluessel ist auf dem Server nicht konfiguriert.");
      return;
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") { setBusy(false); return; }
      const reg = await navigator.serviceWorker.ready;
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
      toast.success("Push auf diesem Geraet aktiviert");
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
      toast.success("Push auf diesem Geraet deaktiviert");
    } catch (e) {
      toast.error("Deaktivierung fehlgeschlagen: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (permission === "unsupported") {
    return (
      <p className="text-xs text-muted-foreground">
        Push-Benachrichtigungen werden in diesem Browser nicht unterstuetzt.
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-red-500/15 text-red-600 dark:text-red-400">
          <Smartphone className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">Push auf diesem Gerät</p>
          <p className="text-xs text-muted-foreground">
            {permission === "denied"
              ? "Im Browser blockiert — Permission in den Browser-Settings zurücksetzen."
              : subscribed
                ? "Aktiv. Push-Toggles in der Tabelle unten wirken nun."
                : "Zuerst aktivieren, damit die Push-Toggles unten wirken."}
          </p>
        </div>
      </div>
      {permission !== "denied" && (
        subscribed
          ? <button type="button" onClick={unsubscribe} disabled={busy} className="kasten kasten-muted text-xs shrink-0">Deaktivieren</button>
          : <button type="button" onClick={subscribe} disabled={busy} className="kasten kasten-red text-xs shrink-0">Aktivieren</button>
      )}
    </div>
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

function Toggle({ value, onChange }: { value: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={value}
      className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}
