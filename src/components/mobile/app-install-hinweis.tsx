"use client";

/**
 * «EVENTLINE als App» (nur Handy, nur im Browser).
 *
 * Zwei Einstiege mit demselben Inhalt:
 *   - <AppInstallHinweis/>  einmaliger Auto-Hinweis (Layout), Regeln unten.
 *   - <AppInstallSheet/>    auf Wunsch aus Mein Konto («App installieren»).
 *
 * Android/Chrome: der Browser meldet `beforeinstallprompt` — wir halten das
 * Ereignis fest und loesen den System-Dialog per Knopf aus.
 * iPhone/Safari: Apple erlaubt keinen Knopf — drei kurze Schritte.
 *
 * Regeln Auto-Hinweis (Entscheid Mischa 2026-10-11): einmal pro Geraet;
 * nicht, wenn die App schon installiert ist (standalone); nicht ueber anderen
 * Dialogen (Neue Funktionen, Mein-Konto-Intro, Benachrichtigungs-Popups);
 * «Nicht jetzt» = nie wieder fragen. Danach darf Chrome seine eigene Install-
 * Leiste wieder zeigen (das Inline-Script im Root-Layout unterdrueckt sie
 * nur, solange unser Hinweis noch kommen kann).
 *
 * Das `beforeinstallprompt`-Ereignis feuert in Chrome oft VOR dem Mount
 * dieser Komponente — darum faengt ein Inline-Script in src/app/layout.tsx
 * es ab und legt es in window.__eventlineInstallPrompt; hier wird es nur
 * noch gelesen (plus Event fuer den Fall, dass es spaeter kommt).
 */

import { useEffect, useRef, useState } from "react";
import { Download, Share, SquarePlus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { useIsMobile } from "@/lib/use-is-mobile";

/** localStorage-Schluessel — identisch im Inline-Script in src/app/layout.tsx. */
const KEY = "eventline-app-hinweis-v1";
const VERZOEGERUNG_MS = 10_000;

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
type WindowMitPrompt = Window & { __eventlineInstallPrompt?: BeforeInstallPromptEvent | null };

function merken(wert: "installiert" | "abgelehnt") {
  try { localStorage.setItem(KEY, wert); } catch { /* Storage blockiert — dann fragen wir beim naechsten Mal */ }
}

/** Laeuft die Seite bereits als installierte App (Startbildschirm)? */
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

/** Vom Inline-Script abgefangenes Install-Ereignis (Android/Chrome), falls da. */
function gemerkterPrompt(): BeforeInstallPromptEvent | null {
  if (typeof window === "undefined") return null;
  return (window as WindowMitPrompt).__eventlineInstallPrompt ?? null;
}

/** System-Dialog ausloesen und das Ereignis verbrauchen (Chrome feuert es
 *  nur einmal je Seite). Gibt zurueck, ob der Nutzer angenommen hat. */
async function promptAusloesen(p: BeforeInstallPromptEvent): Promise<boolean> {
  try {
    await p.prompt();
    const { outcome } = await p.userChoice;
    return outcome === "accepted";
  } catch {
    return false;
  } finally {
    (window as WindowMitPrompt).__eventlineInstallPrompt = null;
  }
}

/** Einmaliger Auto-Hinweis — gemountet im Layout. */
export function AppInstallHinweis() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [plattform, setPlattform] = useState<"android" | "ios">("ios");
  const [busy, setBusy] = useState(false);
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);

  // Install-Ereignis: schon vom Inline-Script abgefangen (window-Feld) oder
  // kommt spaeter als Event. Chrome feuert es einmal pro Seite.
  useEffect(() => {
    promptRef.current = gemerkterPrompt();
    const onPrompt = () => {
      promptRef.current = gemerkterPrompt();
    };
    const onInstalled = () => {
      merken("installiert");
      setOpen(false);
    };
    window.addEventListener("eventline:installprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("eventline:installprompt", onPrompt);
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
      // Stempeln …) oder ueber Benachrichtigungs-Popups — dann beim
      // naechsten Seitenaufruf nochmals versuchen.
      if (document.querySelector('[role="dialog"], [data-overlay="popups"]')) return;
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
    const angenommen = await promptAusloesen(p);
    merken(angenommen ? "installiert" : "abgelehnt");
    promptRef.current = null;
    setBusy(false);
    setOpen(false);
  }

  return (
    <Modal open={open} onClose={nichtJetzt} sheet size="md" closable={!busy}>
      <InstallInhalt
        plattform={plattform}
        promptDa
        busy={busy}
        onInstallieren={installieren}
        onFertig={nichtJetzt}
      />
      <button
        type="button"
        onClick={nichtJetzt}
        disabled={busy}
        className="flex min-h-[34px] w-full items-center justify-center text-[13px] font-medium text-muted-foreground"
      >
        Nicht jetzt
      </button>
    </Modal>
  );
}

/** Auf Wunsch geoeffnet (Mein Konto → «App installieren»). Kein Merken von
 *  «abgelehnt» — der Nutzer hat selbst gefragt. */
export function AppInstallSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const plattform = istIos() ? "ios" : "android";
  const promptDa = gemerkterPrompt() !== null;

  async function installieren() {
    const p = gemerkterPrompt();
    if (!p) return;
    setBusy(true);
    const angenommen = await promptAusloesen(p);
    if (angenommen) merken("installiert");
    setBusy(false);
    onClose();
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} sheet size="md" closable={!busy} ariaLabel="App installieren">
      <InstallInhalt
        plattform={plattform}
        promptDa={promptDa}
        busy={busy}
        onInstallieren={installieren}
        onFertig={onClose}
      />
    </Modal>
  );
}

/** Gemeinsamer Inhalt: Kopf mit App-Icon, Satz, dann Android-Knopf oder die
 *  drei iOS-Schritte. Android ohne Install-Ereignis (Chrome hat es schon
 *  verbraucht oder die Kriterien sind nicht erfuellt): Weg ueber das
 *  Browser-Menue als Text. */
function InstallInhalt({
  plattform,
  promptDa,
  busy,
  onInstallieren,
  onFertig,
}: {
  plattform: "android" | "ios";
  promptDa: boolean;
  busy: boolean;
  onInstallieren: () => void;
  onFertig: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- App-Icon aus /public, feste Groesse */}
        <img src="/icon-192.png" alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-2xl shadow-md" />
        <div className="min-w-0">
          <h2 className="font-heading text-xl font-bold leading-tight">EVENTLINE als App</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Direkt auf deinem Startbildschirm</p>
        </div>
      </div>
      <p className="text-base leading-relaxed">
        Öffnet schneller, direkt vom Startbildschirm und ohne Browser-Leiste.
      </p>

      {plattform === "android" && promptDa ? (
        <button
          type="button"
          onClick={onInstallieren}
          disabled={busy}
          className="kasten kasten-red w-full !h-[40px] !text-[15px]"
        >
          <Download className="h-5 w-5" />
          {busy ? "Wird installiert…" : "App installieren"}
        </button>
      ) : (
        <>
          <ol className="overflow-hidden rounded-xl bg-muted/60">
            {plattform === "ios" ? (
              <>
                <Schritt nr={1} text="Auf das Teilen-Symbol tippen" icon={<Share className="h-5 w-5 text-blue-600 dark:text-blue-300" />} />
                <Schritt nr={2} text="«Zum Home-Bildschirm» wählen" icon={<SquarePlus className="h-5 w-5 text-foreground/70" />} />
                <Schritt nr={3} text="«Hinzufügen» tippen" />
              </>
            ) : (
              <>
                <Schritt nr={1} text="Browser-Menü (⋮ oben rechts) öffnen" />
                <Schritt nr={2} text="«App installieren» oder «Zum Startbildschirm hinzufügen» wählen" icon={<SquarePlus className="h-5 w-5 text-foreground/70" />} />
              </>
            )}
          </ol>
          <button type="button" onClick={onFertig} className="kasten kasten-red w-full !h-[38px] !text-base">
            Verstanden
          </button>
        </>
      )}
    </>
  );
}

function Schritt({ nr, text, icon }: { nr: number; text: string; icon?: React.ReactNode }) {
  return (
    <li className="flex min-h-[40px] items-center gap-3 border-t border-border/60 px-3 py-2 first:border-t-0">
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card text-sm font-bold">{nr}</span>
      <span className="flex-1 text-base">{text}</span>
      {icon}
    </li>
  );
}
