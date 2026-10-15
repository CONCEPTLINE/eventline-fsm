"use client";

/**
 * Partner-Notifications-Card (Konto-Seite Partner- und Lieferantenportal).
 *
 * 1. Push-Aktivierung fuer das aktuelle Geraet (nur einmal noetig).
 * 2. Matrix pro Event × Kanal (E-Mail, Push) — Partner steuert selbst
 *    welche Events er wo bekommt. Speichert in user_notification_settings
 *    (bestehende Kanal-Matrix, die alle Notification-Sender in der App
 *    eh schon respektieren).
 *
 * Lesen und Schreiben ueber /api/portal/benachrichtigungen: der Server
 * nimmt das angesehene Konto (effectiveUserId). In der «Ansicht als» zeigt
 * die Karte darum die Einstellungen der Person, nicht die des Admins;
 * Schalten geht dort nur im Bearbeiten-Modus des Overlays (gilt dann fuer
 * die Person), sonst gesperrt mit Hinweis. Die Push-Aktivierung gilt fuer
 * DIESES Geraet und bleibt in der Ansicht als gesperrt.
 *
 * Bewusst OHNE In-App-Spalte — das Partnerportal ist so schlank, die
 * Bell-Historie ist dort kein primaerer Kanal.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Bell, Eye, Mail, RotateCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { configurableNotificationEvents } from "@/lib/notification-meta";
import { readImpersonationWriteCookie } from "@/lib/impersonation";
import type { NotificationType } from "@/types";

// Relevante Notification-Types pro Portal-Zielgruppe — abgeleitet aus
// NOTIFICATION_META (audience partner|lieferant/beide) statt eigener Arrays.

type Channel = "email" | "push";
type ChannelSet = Partial<Record<Channel, boolean>>;
type Channels = Partial<Record<NotificationType, ChannelSet>>;

type Laden =
  | { status: "laedt" }
  | { status: "fehler" }
  | { status: "ok"; ansichtAls: boolean; name: string | null };

const GESPERRT_TOOLTIP = "In der «Ansicht als» nur lesen — Bearbeitung im Overlay aktivieren";

function effectiveChannel(channels: Channels, type: NotificationType, key: Channel): boolean {
  const ev = channels[type];
  if (!ev || ev[key] === undefined) {
    // Default: E-Mail an (klassischer Kanal), Push aus (opt-in via Aktivierung).
    return key === "email";
  }
  return Boolean(ev[key]);
}

/** Bearbeiten-Modus der «Ansicht als» — im Overlay jederzeit umschaltbar,
 *  darum live aus dem Cookie (nur waehrend der Ansicht als abgefragt). */
function useSchreibmodus(ansichtAls: boolean): boolean {
  const subscribe = useCallback((melden: () => void) => {
    if (!ansichtAls) return () => {};
    const t = window.setInterval(melden, 1000);
    return () => window.clearInterval(t);
  }, [ansichtAls]);
  const an = useSyncExternalStore(subscribe, readImpersonationWriteCookie, () => false);
  return ansichtAls && an;
}

export function PartnerNotificationsCard({
  // Auch im Lieferantenportal nutzbar — gleiche Matrix, andere Event-Liste.
  audience = "partner",
}: {
  audience?: "partner" | "lieferant";
} = {}) {
  const PARTNER_EVENTS = configurableNotificationEvents(audience);
  const [laden, setLaden] = useState<Laden>({ status: "laedt" });
  const [channels, setChannels] = useState<Channels>({});
  const [saving, setSaving] = useState(false);
  const ansichtAls = laden.status === "ok" && laden.ansichtAls;
  const schreibmodus = useSchreibmodus(ansichtAls);
  const gesperrt = ansichtAls && !schreibmodus;

  // Setzt nur Ergebnis/Fehler; den Lade-Zustand setzt der Aufrufer (Start =
  // Initialwert, «Erneut laden» = Klick).
  const ladeEinstellungen = useCallback(async () => {
    try {
      const res = await fetch("/api/portal/benachrichtigungen", { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Benachrichtigungen konnten nicht geladen werden");
      setChannels((j.channels as Channels) ?? {});
      setLaden({ status: "ok", ansichtAls: j.ansichtAls === true, name: (j.name as string | null) ?? null });
    } catch (e) {
      setLaden({ status: "fehler" });
      toast.error(e instanceof Error ? e.message : "Benachrichtigungen konnten nicht geladen werden");
    }
  }, []);
  useEffect(() => { void ladeEinstellungen(); }, [ladeEinstellungen]);

  async function toggle(type: NotificationType, key: Channel) {
    // Ein Schalter nach dem anderen: der Server fuehrt jeden Klick in den
    // gespeicherten Stand ein — parallele Anfragen koennten sich ueberholen.
    if (gesperrt || saving) return;
    const vorher = channels;
    const an = !effectiveChannel(channels, type, key);
    setChannels({ ...channels, [type]: { ...(channels[type] ?? {}), [key]: an } });
    setSaving(true);
    try {
      const res = await fetch("/api/portal/benachrichtigungen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ typ: type, kanal: key, an }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Speichern fehlgeschlagen");
      setChannels((j.channels as Channels) ?? {});
    } catch (e) {
      setChannels(vorher);
      toast.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  return (
    // Am Handy ohne Card-Polster (py-4/gap-4): Kopf- und Fusszeile tragen
    // ihren Abstand selbst — sonst doppelt so viel Luft wie bei «Profil».
    <Card className="bg-card max-md:py-0 max-md:gap-0">
      <CardContent className="p-0">
        <div className="p-4 border-b border-border flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-muted-foreground">Benachrichtigungen</h2>
          {saving && <span className="ml-auto text-[10px] text-muted-foreground/70">Speichert…</span>}
        </div>

        {/* «Ansicht als»: wessen Einstellungen hier stehen und ob Schalten geht. */}
        {laden.status === "ok" && laden.ansichtAls && (
          <div className="px-4 pt-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <Eye className="h-4 w-4 shrink-0 mt-0.5" />
              <p>
                <strong className="font-semibold">Ansicht als:</strong> Einstellungen von {laden.name ?? "dieser Person"}.{" "}
                {schreibmodus
                  ? "Bearbeitung aktiv — Änderungen gelten für diese Person."
                  : "Nur lesen — zum Ändern im Overlay die Bearbeitung aktivieren."}
              </p>
            </div>
          </div>
        )}

        {/* Push-Aktivierung — Voraussetzung damit Push-Toggles unten wirken. */}
        <div className="p-4 border-b border-border">
          <PushActivationRow ansichtAls={ansichtAls} />
        </div>

        {/* Event × Kanal-Matrix */}
        {laden.status === "laedt" ? (
          <p className="p-4 text-xs text-muted-foreground">Lädt…</p>
        ) : laden.status === "fehler" ? (
          <div className="p-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Benachrichtigungen konnten nicht geladen werden.</p>
            <button
              type="button"
              onClick={() => { setLaden({ status: "laedt" }); void ladeEinstellungen(); }}
              className="kasten kasten-muted text-xs shrink-0"
            >
              <RotateCw className="h-3.5 w-3.5" /> Erneut laden
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Ereignis</th>
                  <th className="text-center px-4 py-2.5 w-24 max-md:w-16 max-md:px-2">
                    <div className="flex flex-col items-center gap-1">
                      <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">E-Mail</span>
                    </div>
                  </th>
                  <th className="text-center px-4 py-2.5 w-24 max-md:w-16 max-md:px-2">
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
                    <td className="px-4 py-3 text-center max-md:px-2">
                      <Toggle
                        value={effectiveChannel(channels, e.type, "email")}
                        onChange={() => toggle(e.type, "email")}
                        gesperrt={gesperrt}
                        speichert={saving}
                      />
                    </td>
                    <td className="px-4 py-3 text-center max-md:px-2">
                      <Toggle
                        value={effectiveChannel(channels, e.type, "push")}
                        onChange={() => toggle(e.type, "push")}
                        gesperrt={gesperrt}
                        speichert={saving}
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
 *  Ohne Aktivierung feuert Push nicht — auch wenn ein Event-Toggle an ist.
 *  In der «Ansicht als» gesperrt: die Aktivierung gilt fuer DIESES Geraet
 *  und das angemeldete Konto, nie fuer die angesehene Person. */
function PushActivationRow({ ansichtAls }: { ansichtAls: boolean }) {
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
      toast.success("Push auf diesem Gerät aktiviert");
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
      toast.success("Push auf diesem Gerät deaktiviert");
    } catch (e) {
      toast.error("Deaktivierung fehlgeschlagen: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (permission === "unsupported") {
    return (
      <p className="text-xs text-muted-foreground">
        Push-Benachrichtigungen werden in diesem Browser nicht unterstützt.
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
            {ansichtAls
              ? "In der «Ansicht als» gesperrt — gilt für dieses Gerät, nicht für die angesehene Person."
              : permission === "denied"
                ? "Im Browser blockiert — Permission in den Browser-Settings zurücksetzen."
                : subscribed
                  ? "Aktiv. Push-Toggles in der Tabelle unten wirken nun."
                  : "Zuerst aktivieren, damit die Push-Toggles unten wirken."}
          </p>
        </div>
      </div>
      {!ansichtAls && permission !== "denied" && (
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

// Der Knopf ist die Tastflaeche, die Spur sitzt innen: am Handy 40×34 px,
// am Desktop deckt der Knopf die Spur exakt ab (Optik wie bisher).
// gesperrt («Ansicht als», nur lesen): ausgegraut, nicht schaltbar, Tooltip.
// speichert: kurz nicht schaltbar, bis der vorige Klick gespeichert ist
// (Kopfzeile zeigt «Speichert…») — Schalter wirken nacheinander, keiner geht verloren.
function Toggle({ value, onChange, gesperrt = false, speichert = false }: {
  value: boolean; onChange: () => void; gesperrt?: boolean; speichert?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={gesperrt || speichert}
      role="switch"
      aria-checked={value}
      data-tooltip={gesperrt ? GESPERRT_TOOLTIP : undefined}
      className={`inline-flex items-center justify-center rounded-full max-md:h-[34px] max-md:w-[40px] ${gesperrt ? "opacity-50 cursor-not-allowed" : speichert ? "cursor-wait" : ""}`}
    >
      <span className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"}`}>
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}
