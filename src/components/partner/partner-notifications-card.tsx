"use client";

/**
 * Partner-Notifications-Card (Konto-Seite Partnerportal).
 *
 * Zwei Kanaele:
 *   1. Push auf dem aktuellen Geraet (via PushManager + /api/notifications/
 *      subscribe). Toggle registriert / de-registriert die Subscription.
 *   2. E-Mail an die Partner-Adresse. Global-Flag; Backend prueft das
 *      beim Versand (mail_enabled im channels-Blob).
 *
 * Bewusst schlank — kein Event-Matrix wie fuer interne User. Partner
 * bekommen wenige Notification-Typen, ein globaler Ein/Aus-Schalter
 * pro Kanal reicht.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Bell, Mail, Smartphone } from "lucide-react";
import { toast } from "sonner";

// Notification-Types die den Partner tangieren. Wenn Mail-Toggle=on,
// setzen wir channels[type].email=true fuer jeden hier gelisteten Typ.
const PARTNER_NOTIFICATION_TYPES = ["system", "appointment_new"] as const;

export function PartnerNotificationsCard() {
  return (
    <Card className="bg-card">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-muted-foreground">Benachrichtigungen</h2>
        </div>
        <EmailToggleRow />
        <PushToggleRow />
      </CardContent>
    </Card>
  );
}

function EmailToggleRow() {
  const supabase = createClient();
  const [enabled, setEnabled] = useState(false);
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
        .select("channels")
        .eq("user_id", user.id)
        .maybeSingle();
      // Enabled = mindestens einer der Partner-Typen hat email=true.
      const channels = (data?.channels ?? {}) as Record<string, { email?: boolean }>;
      const anyOn = PARTNER_NOTIFICATION_TYPES.some((t) => channels[t]?.email === true);
      setEnabled(anyOn);
      setLoading(false);
    })();
  }, [supabase]);

  async function toggle() {
    if (!userId) return;
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    // Bestehende channels lesen, gezielt fuer die Partner-Typen email flippen.
    const { data } = await supabase
      .from("user_notification_settings")
      .select("channels")
      .eq("user_id", userId)
      .maybeSingle();
    const channels = ((data?.channels ?? {}) as Record<string, Record<string, boolean>>);
    for (const t of PARTNER_NOTIFICATION_TYPES) {
      channels[t] = { ...(channels[t] ?? {}), email: next };
    }
    const { error } = await supabase
      .from("user_notification_settings")
      .upsert({ user_id: userId, channels }, { onConflict: "user_id" });
    setSaving(false);
    if (error) {
      setEnabled(!next);
      toast.error("Konnte nicht speichern: " + error.message);
      return;
    }
    toast.success(next ? "E-Mail aktiviert" : "E-Mail deaktiviert");
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/15 text-blue-600 dark:text-blue-400">
          <Mail className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-semibold">E-Mail-Benachrichtigungen</p>
          <p className="text-xs text-muted-foreground">
            Bekommst bei neuen Anfragen, Antworten und Terminen eine E-Mail an deine hinterlegte Adresse.
          </p>
        </div>
      </div>
      <Toggle value={enabled} onChange={toggle} disabled={loading || saving} />
    </div>
  );
}

function PushToggleRow() {
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
      <p className="text-xs text-muted-foreground">
        Push-Benachrichtigungen werden in diesem Browser nicht unterstuetzt.
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-red-500/15 text-red-600 dark:text-red-400">
          <Smartphone className="h-4 w-4" />
        </div>
        <div>
          <p className="text-sm font-semibold">Push auf diesem Geraet</p>
          <p className="text-xs text-muted-foreground">
            {permission === "denied"
              ? "Im Browser blockiert — Permission in den Browser-Settings zuruecksetzen."
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

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChange}
      role="switch"
      aria-checked={value}
      disabled={disabled}
      className={`inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
        disabled
          ? "bg-foreground/10 cursor-not-allowed opacity-40"
          : value ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"
      }`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}
