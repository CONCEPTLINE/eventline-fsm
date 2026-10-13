"use client";

/**
 * Passkey-Verwaltung im Mein-Konto — User kann neue Passkeys registrieren
 * (Face-ID / Touch-ID / Windows-Hello / USB-Key) und alte löschen.
 *
 * Passkey ist ein zusätzlicher Login-Weg — Passwort bleibt weiter aktiv.
 *
 * Flow beim "Neuen Passkey einrichten":
 *   1. POST /api/auth/passkey/register-challenge → WebAuthn-Optionen
 *   2. startRegistration(options) — Browser promptet Face-ID/Touch-ID
 *   3. POST /api/auth/passkey/register-verify mit Antwort
 *   4. Reload der Liste
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Fingerprint, Plus, Trash2, Loader2, Smartphone, KeyRound, Info } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/use-confirm";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { ZRH_TZ } from "@/lib/swiss-time";

interface Passkey {
  id: string;
  nickname: string | null;
  device_type: string;
  backed_up: boolean;
  transports: string[] | null;
  created_at: string;
  last_used_at: string | null;
}

function formatDate(iso: string | null): string {
  if (!iso) return "noch nie";
  try {
    return new Date(iso).toLocaleDateString("de-CH", {
      timeZone: ZRH_TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

// Freundlicher Name je nachdem wie der Passkey aussieht: Face-ID / Touch-ID /
// Windows-Hello (Platform, transports=internal) vs. USB-Key.
function iconFor(pk: Passkey) {
  const isPlatform = pk.transports?.includes("internal") ?? false;
  return isPlatform ? Smartphone : KeyRound;
}

function suggestNickname(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android-Handy";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows-PC";
  return "";
}

interface PasskeysCardProps {
  /** Optional Callback nach erfolgreicher Passkey-Registrierung. Wird vom
   *  Passkey-Enrollment-Screen (/passkey-setup) genutzt, um nach dem ersten
   *  Passkey ins Dashboard weiterzuleiten. */
  onRegistered?: () => void;
}

export function PasskeysCard({ onRegistered }: PasskeysCardProps = {}) {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [supported, setSupported] = useState(true);
  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/passkey/list");
      const json = await res.json();
      if (res.ok && json.success) setPasskeys(json.passkeys as Passkey[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRegister() {
    setRegistering(true);
    try {
      const chRes = await fetch("/api/auth/passkey/register-challenge", { method: "POST" });
      const chJson = await chRes.json();
      if (!chRes.ok || !chJson.success) {
        toast.error(chJson.error ?? "Registrierung konnte nicht gestartet werden");
        return;
      }

      let regResp;
      try {
        regResp = await startRegistration({ optionsJSON: chJson.options });
      } catch (e) {
        // User hat abgebrochen oder Gerät kann keinen Passkey liefern
        const msg = e instanceof Error ? e.message : "Abgebrochen";
        if (!/cancel|abort/i.test(msg)) toast.error(msg);
        return;
      }

      const suggestion = suggestNickname();
      const nickname = window.prompt(
        "Namen für diesen Passkey (z. B. Gerät):",
        suggestion,
      );
      // nickname === null → User hat den Prompt abgebrochen; wir speichern
      // trotzdem, weil der Passkey am Gerät bereits erzeugt wurde und
      // ansonsten "verwaist" im Authenticator bliebe. Fallback-Name.
      const finalName = (nickname ?? "").trim() || suggestion || "Passkey";

      const verifyRes = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: regResp, nickname: finalName }),
      });
      const verifyJson = await verifyRes.json();
      if (!verifyRes.ok || !verifyJson.success) {
        toast.error(verifyJson.error ?? "Speichern fehlgeschlagen");
        return;
      }
      toast.success("Passkey eingerichtet");
      load();
      onRegistered?.();
    } finally {
      setRegistering(false);
    }
  }

  async function handleDelete(pk: Passkey) {
    const label = pk.nickname ?? "Dieser Passkey";
    const ok = await confirm({
      title: `„${label}" entfernen?`,
      message: "Du kannst dich mit diesem Passkey danach nicht mehr einloggen. Passwort-Login funktioniert weiter.",
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (!ok) return;
    const res = await fetch(`/api/auth/passkey/list?id=${pk.id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok || !json.success) {
      toast.error(json.error || "Entfernen fehlgeschlagen");
      return;
    }
    toast.success("Passkey entfernt");
    load();
  }

  return (
    <Card className="bg-card">
      {ConfirmModalElement}
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Fingerprint className="h-4 w-4" />
          Passkeys — biometrische Anmeldung
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Mit einem Passkey meldest du dich per Face-ID, Touch-ID,
          Fingerabdruck oder Windows-Hello an — ohne Passwort. Du kannst
          mehrere Geräte registrieren (Handy, Laptop, Sicherheits-Key).
          Passwort-Login bleibt zusätzlich aktiv.
        </p>

        {!supported && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2.5 text-xs">
            <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div className="text-amber-800 dark:text-amber-200">
              Dieser Browser unterstützt keine Passkeys. Bitte auf iOS/Safari,
              Chrome (Android/Desktop), Edge oder Firefox aktuell umsteigen.
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground italic">Lade…</p>
        ) : passkeys.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Noch keine Passkeys eingerichtet.</p>
        ) : (
          <div className="space-y-1.5">
            {passkeys.map((pk) => {
              const Icon = iconFor(pk);
              return (
                <div
                  key={pk.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-foreground/10 px-3 py-2 bg-background/40"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon className="h-4 w-4 shrink-0 text-foreground/70" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {pk.nickname ?? "Passkey"}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Erstellt {formatDate(pk.created_at)} · Zuletzt {formatDate(pk.last_used_at)}
                        {pk.backed_up ? " · Synchronisiert" : ""}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(pk)}
                    className="kasten kasten-muted !py-1 !px-2 max-md:h-[34px] max-md:w-[34px]"
                    data-tooltip="Entfernen"
                    aria-label="Passkey entfernen"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={handleRegister}
            disabled={registering || !supported}
            className="kasten kasten-blue"
          >
            {registering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {registering ? "Wird eingerichtet…" : "Neuen Passkey einrichten"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
