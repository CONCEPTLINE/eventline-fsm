"use client";

/**
 * Benachrichtigungs-Einstellungen pro User (Mein Konto → Benachrichtigungen).
 *
 * Matrix Event × Kanal: pro Event-Typ kann der User pro Kanal an/aus
 * setzen. Was ohne gespeicherten Wert gilt, kommt aus notification-meta
 * (kanalAktiv / KANAL_STANDARD: alles an) — derselben Quelle, nach der der
 * Service versendet. Welche Kanaele schaltbar sind: SCHALTBARE_KANAELE.
 *
 * Quiet Hours: Push-spezifisch (kommt mit Phase 5 Web-Push). In-App
 * Notifications werden immer geschrieben damit die Historie komplett
 * bleibt.
 *
 * Autosave: Toggle aendert -> sofort gespeichert, kein Save-Button. Lesen
 * und Schreiben ueber /api/notifications/einstellungen (gemeinsame Daten-
 * Schicht mit der Konto-Karte der Portale): der Server nimmt das angesehene
 * Konto. In der «Ansicht als» stehen hier die Einstellungen der Person;
 * Schalten nur im Bearbeiten-Modus des Overlays (gilt dann fuer die Person),
 * sonst gesperrt mit Hinweis. Push-Aktivierung gilt fuer DIESES Geraet und
 * bleibt in der Ansicht als gesperrt.
 */

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { toast } from "sonner";
import { Bell, Mail, Smartphone, Clock, Volume2, RotateCw } from "lucide-react";
import { isSoundEnabled, setSoundEnabled, playNotificationSound } from "@/lib/notification-sound";
import {
  configurableNotificationEvents, kanalAktiv, SCHALTBARE_KANAELE, type NotificationChannel,
} from "@/lib/notification-meta";
import {
  useBenachrichtigungsEinstellungen, AnsichtAlsHinweis, ANSICHT_ALS_GESPERRT_TOOLTIP,
} from "@/lib/use-benachrichtigungs-einstellungen";
import type { NotificationType } from "@/types";

/** Event-Zeilen fuer die Matrix-UI — abgeleitet aus NOTIFICATION_META
 *  (Single Source of Truth) statt eines eigenen Arrays. Damit tauchen
 *  auch job_overdue / todo_overdue auf und sind
 *  abschaltbar (Audit-Befund: die waren vorher nicht konfigurierbar). */
const EVENTS = configurableNotificationEvents("intern");

const CHANNELS: { key: NotificationChannel; label: string; icon: typeof Bell; tooltip?: string }[] = [
  { key: "in_app", label: "In-App",  icon: Bell },
  { key: "email",  label: "E-Mail",  icon: Mail,       tooltip: "Folgt in einer nächsten Phase" },
  { key: "push",   label: "Push",    icon: Smartphone },
];
const schaltbar = (k: NotificationChannel) => SCHALTBARE_KANAELE.intern.includes(k);

export function BenachrichtigungenTab() {
  const { laden, stand, saving, ansichtAls, schreibmodus, gesperrt, erneutLaden, speichern } = useBenachrichtigungsEinstellungen();
  const channels = useMemo(() => stand?.channels ?? {}, [stand]);

  function toggleChannel(type: NotificationType, key: NotificationChannel) {
    const an = !kanalAktiv(channels, type, key);
    void speichern(
      { art: "kanal", typ: type, kanal: key, an },
      (s) => ({ ...s, channels: { ...s.channels, [type]: { ...(s.channels[type] ?? {}), [key]: an } } }),
    );
  }

  function setQuietHoursEnabled(an: boolean) {
    void speichern({ art: "stille", an }, (s) => ({ ...s, stille: { ...s.stille, an } }));
  }

  function setQuietHoursTime(field: "start" | "end", value: string) {
    void speichern(
      field === "start" ? { art: "stille", von: value } : { art: "stille", bis: value },
      (s) => ({ ...s, stille: { ...s.stille, [field === "start" ? "von" : "bis"]: value } }),
    );
  }

  // Alle aus / Alle an Convenience (in_app-Spalte)
  const allInAppOn = useMemo(
    () => EVENTS.every((e) => kanalAktiv(channels, e.type, "in_app")),
    [channels]
  );

  function setAllInApp(an: boolean) {
    void speichern({ art: "alle_in_app", an }, (s) => {
      const next = { ...s.channels };
      for (const e of EVENTS) next[e.type] = { ...(next[e.type] ?? {}), in_app: an };
      return { ...s, channels: next };
    });
  }

  if (laden === "laedt" || (laden === "ok" && !stand)) return <p className="text-sm text-muted-foreground">Laedt…</p>;
  if (laden === "fehler" || !stand) {
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>Benachrichtigungen konnten nicht geladen werden.</span>
        <button type="button" onClick={erneutLaden} className="kasten kasten-muted text-xs">
          <RotateCw className="h-3.5 w-3.5" /> Erneut laden
        </button>
      </div>
    );
  }
  const sperre = gesperrt || saving;

  return (
    <div className="space-y-4 max-w-3xl">
      {/* «Ansicht als»: wessen Einstellungen hier stehen und ob Schalten geht. */}
      {ansichtAls && <AnsichtAlsHinweis name={stand.name} schreibmodus={schreibmodus} />}

      {/* Sound + Push */}
      <SoundToggleCard />
      <PushSubscriptionCard ansichtAls={ansichtAls} />

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
                      <c.icon className={`h-4 w-4 ${schaltbar(c.key) ? "" : "opacity-40"}`} />
                      <span className={`text-[10px] uppercase tracking-wider ${schaltbar(c.key) ? "" : "opacity-40"}`}>{c.label}</span>
                    </div>
                  </th>
                ))}
              </tr>
              <tr className="border-b border-border bg-muted/20">
                <td className="px-4 py-2 text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => setAllInApp(!allInAppOn)}
                    disabled={sperre}
                    data-tooltip={gesperrt ? ANSICHT_ALS_GESPERRT_TOOLTIP : undefined}
                    className={`hover:text-foreground transition-colors max-md:inline-flex max-md:min-h-[34px] max-md:items-center ${gesperrt ? "opacity-50 cursor-not-allowed" : saving ? "cursor-wait" : ""}`}
                  >
                    {allInAppOn ? "Alle aus" : "Alle an"}
                  </button>
                </td>
                {CHANNELS.map((c) => (
                  <td key={c.key} className="px-4 py-2 text-center text-[10px] text-muted-foreground">
                    {!schaltbar(c.key) && <span data-tooltip={c.tooltip}>noch nicht</span>}
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
                        value={kanalAktiv(channels, e.type, c.key)}
                        onChange={() => toggleChannel(e.type, c.key)}
                        disabled={!schaltbar(c.key)}
                        gesperrt={gesperrt}
                        speichert={saving}
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
            <Toggle value={stand.stille.an} onChange={() => setQuietHoursEnabled(!stand.stille.an)} gesperrt={gesperrt} speichert={saving} />
          </div>
          {stand.stille.an && (
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/60">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Von</label>
                <ZeitFeld
                  eigenesStyling
                  value={stand.stille.von}
                  onChange={(v) => setQuietHoursTime("start", v)}
                  disabled={gesperrt}
                  className={`mt-1 w-full h-9 px-3 text-sm rounded-lg border border-border bg-background ${gesperrt ? "opacity-50 cursor-not-allowed" : ""}`}
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Bis</label>
                <ZeitFeld
                  eigenesStyling
                  value={stand.stille.bis}
                  onChange={(v) => setQuietHoursTime("end", v)}
                  disabled={gesperrt}
                  className={`mt-1 w-full h-9 px-3 text-sm rounded-lg border border-border bg-background ${gesperrt ? "opacity-50 cursor-not-allowed" : ""}`}
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
 *  pro-Geraet-Liste mit Entfernen-Button. In der «Ansicht als» gesperrt:
 *  die Aktivierung gilt fuer DIESES Geraet und das angemeldete Konto, nie
 *  fuer die angesehene Person. */
function PushSubscriptionCard({ ansichtAls }: { ansichtAls: boolean }) {
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
              {ansichtAls
                ? "In der «Ansicht als» gesperrt — gilt für dieses Gerät, nicht für die angesehene Person."
                : permission === "denied"
                  ? "Im Browser blockiert — Permission in den Browser-Settings zurücksetzen."
                  : subscribed
                    ? "Aktiv. Du bekommst System-Benachrichtigungen auch wenn die App geschlossen ist."
                    : "Nicht aktiviert. Aktivieren um auch ohne offene App benachrichtigt zu werden."}
            </p>
          </div>
        </div>
        {!ansichtAls && permission !== "denied" && (
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

// Der Knopf ist nur die Tastflaeche (am Handy < md mindestens 34 px), die
// Schiene liegt als Span darin — am Desktop so gross wie bisher.
// disabled = Kanal (noch) nicht schaltbar (graue Schiene); gesperrt = «Ansicht
// als», nur lesen (Wert sichtbar, ausgegraut, Tooltip); speichert = kurz
// nicht schaltbar, bis der vorige Klick gespeichert ist.
function Toggle({ value, onChange, disabled, gesperrt = false, speichert = false }: {
  value: boolean; onChange: () => void; disabled?: boolean; gesperrt?: boolean; speichert?: boolean;
}) {
  const aus = disabled || gesperrt || speichert;
  return (
    <button
      type="button"
      onClick={aus ? undefined : onChange}
      role="switch"
      aria-checked={value}
      disabled={aus}
      data-tooltip={gesperrt && !disabled ? ANSICHT_ALS_GESPERRT_TOOLTIP : undefined}
      className={`inline-flex items-center justify-center max-md:min-h-[34px] max-md:min-w-[34px] ${
        disabled ? "cursor-not-allowed opacity-40" : gesperrt ? "cursor-not-allowed opacity-50" : speichert ? "cursor-wait" : ""
      }`}
    >
      <span
        className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          disabled
            ? "bg-foreground/10"
            : value ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"
        }`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}
