"use client";

/**
 * Einmaliger Hinweis «EVENTLINE als App» (nur Handy, nur im Browser).
 *
 * Android/Chrome: der Browser meldet `beforeinstallprompt` — wir halten das
 * Ereignis fest und loesen den System-Dialog per Knopf aus.
 * iPhone/Safari: Apple erlaubt keinen Knopf — drei kurze Schritte.
 *
 * Regeln (Entscheid Mischa 2026-10-11): einmal pro Geraet; nicht, wenn die
 * App schon installiert ist (standalone); nicht ueber anderen Dialogen
 * (Neue Funktionen, Mein-Konto-Intro); «Nicht jetzt» = nie wieder fragen.
 * Danach bleibt die Installation unter Mein Konto erreichbar.
 */

import { useEffect, useRef, useState } from "react";
import { Download, Share, SquarePlus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { useIsMobile } from "@/lib/use-is-mobile";

const KEY = "eventline-app-hinweis-v1";
const VERZOEGERUNG_MS = 10_000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function merken(wert: "installiert" | "abgelehnt") {
  try { localStorage.setItem(KEY, wert); } catch { /* Storage blockiert — dann fragen wir beim naechsten Mal */ }
}

export function istAlsAppInstalliert(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function istIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function AppInstallHinweis() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [plattform, setPlattform] = useState<"android" | "ios">("ios");
  const [busy, setBusy] = useState(false);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);

  // Install-Ereignis frueh abfangen (Chrome feuert es einmal pro Seite).
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      promptRef.current = e as BeforeInstallPromptEvent;
    };
    const onInstalled = () => {
      merken("installiert");
      setOpen(false);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (isMobile !== true) return;
    try {
      if (localStorage.getItem(KEY)) return;
    } catch {
      return;
    }
    if (istAlsAppInstalliert()) {
      merken("installiert");
      return;
    }
    const t = window.setTimeout(() => {
      // Nie ueber einem anderen Dialog (Neue Funktionen, Mein-Konto-Intro,
      // Stempeln …) — dann beim naechsten Seitenaufruf nochmals versuchen.
      if (document.querySelector('[role="dialog"]')) return;
      if (istIos()) {
        setPlattform("ios");
        setOpen(true);
      } else if (promptRef.current) {
        setPlattform("android");
        setOpen(true);
      }
      // Android ohne Install-Ereignis (Kriterien nicht erfuellt oder schon
      // abgelehnt): nichts zeigen.
    }, VERZOEGERUNG_MS);
    return () => window.clearTimeout(t);
  }, [isMobile]);

  function nichtJetzt() {
    merken("abgelehnt");
    setOpen(false);
  }

  async function installieren() {
    const p = promptRef.current;
    if (!p) return;
    setBusy(true);
    try {
      await p.prompt();
      const { outcome } = await p.userChoice;
      merken(outcome === "accepted" ? "installiert" : "abgelehnt");
    } catch {
      merken("abgelehnt");
    } finally {
      promptRef.current = null;
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <Modal open={open} onClose={nichtJetzt} sheet size="md" closable={!busy}>
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- App-Icon aus /public, feste Groesse */}
        <img src="/icon-192.png" alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-2xl shadow-md" />
        <div className="min-w-0">
          <h2 className="font-heading text-xl font-bold leading-tight">EVENTLINE als App</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Direkt auf deinem Startbildschirm</p>
        </div>
      </div>
      <p className="text-base leading-relaxed">
        Öffnet schneller, und Stempeln und Rapport funktionieren auch ohne Netz.
      </p>

      {plattform === "android" ? (
        <button
          type="button"
          onClick={installieren}
          disabled={busy}
          className="kasten kasten-red w-full !h-14 !text-[17px]"
        >
          <Download className="h-5 w-5" />
          {busy ? "Wird installiert…" : "App installieren"}
        </button>
      ) : (
        <>
          <ol className="overflow-hidden rounded-xl bg-muted/60">
            <Schritt nr={1} text="Auf das Teilen-Symbol tippen" icon={<Share className="h-5 w-5 text-blue-600 dark:text-blue-300" />} />
            <Schritt nr={2} text="«Zum Home-Bildschirm» wählen" icon={<SquarePlus className="h-5 w-5 text-foreground/70" />} />
            <Schritt nr={3} text="«Hinzufügen» tippen" />
          </ol>
          <button type="button" onClick={nichtJetzt} className="kasten kasten-red w-full !h-13 !text-base">
            Verstanden
          </button>
        </>
      )}
      <button
        type="button"
        onClick={nichtJetzt}
        disabled={busy}
        className="block w-full py-2 text-center text-[15px] font-medium text-muted-foreground"
      >
        Nicht jetzt
      </button>
    </Modal>
  );
}

function Schritt({ nr, text, icon }: { nr: number; text: string; icon?: React.ReactNode }) {
  return (
    <li className="flex min-h-[52px] items-center gap-3 border-t border-border/60 px-3 first:border-t-0">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card text-sm font-bold">{nr}</span>
      <span className="flex-1 text-base">{text}</span>
      {icon}
    </li>
  );
}
