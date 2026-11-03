"use client";

// Eine Frage aus «Fragen an dich» (Katalog src/lib/fragen/katalog.ts) mit
// Optionen und Speichern. Nichts vorausgewählt; Speichern erst nach Wahl.
// Gemeinsam für das Pflicht-Modal und «Mein Konto › Meine Antworten».

import { useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Frage } from "@/lib/fragen/katalog";
import { speichereAntwort } from "@/lib/fragen/use-fragen";

export function FrageFormular({ frage, aktuell, knopf = "Speichern", onGespeichert }: {
  frage: Frage;
  /** Bisherige Antwort (Mein Konto: ändern) — sonst nichts vorausgewählt. */
  aktuell?: string | null;
  knopf?: string;
  onGespeichert?: () => void;
}) {
  const [wahl, setWahl] = useState<string | null>(aktuell ?? null);
  const [speichert, setSpeichert] = useState(false);
  const unveraendert = aktuell != null && wahl === aktuell;

  async function speichern() {
    if (!wahl || speichert) return;
    setSpeichert(true);
    try {
      await speichereAntwort(frage, wahl);
      toast.success("Antwort gespeichert");
      onGespeichert?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    } finally {
      setSpeichert(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2 text-sm leading-relaxed">
        {frage.text.map((t) => <p key={t}>{t}</p>)}
      </div>

      <ul className="space-y-1 text-sm">
        {frage.punkte.map((p) => {
          const i = p.indexOf(":");
          return (
            <li key={p} className="flex gap-2">
              <span className="text-muted-foreground">–</span>
              <span>
                {i > 0 ? <><span className="font-medium">{p.slice(0, i + 1)}</span>{p.slice(i + 1)}</> : p}
              </span>
            </li>
          );
        })}
      </ul>

      {frage.warnung && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/40 text-xs text-amber-900 dark:text-amber-100">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-px text-amber-600 dark:text-amber-300" />
          <p>{frage.warnung}</p>
        </div>
      )}

      <div role="radiogroup" aria-label={frage.titel} className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        {frage.optionen.map((o) => (
          <Option key={o.wert} label={o.label} gewaehlt={wahl === o.wert} disabled={speichert} onWaehle={() => setWahl(o.wert)} />
        ))}
      </div>

      <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2 pt-1">
        <p className="text-[11px] text-muted-foreground sm:flex-1">{frage.hinweis}</p>
        <button
          type="button"
          onClick={() => void speichern()}
          disabled={!wahl || speichert || unveraendert}
          className="kasten kasten-red justify-center"
        >
          {speichert ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {speichert ? "Speichert…" : knopf}
        </button>
      </div>
    </div>
  );
}

function Option({ label, gewaehlt, disabled, onWaehle }: { label: string; gewaehlt: boolean; disabled: boolean; onWaehle: () => void }) {
  const [hover, setHover] = useState(false);
  const rand = gewaehlt ? "var(--color-red-500, #ef4444)" : hover ? "color-mix(in srgb, currentColor 35%, transparent)" : "color-mix(in srgb, currentColor 18%, transparent)";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={gewaehlt}
      disabled={disabled}
      onClick={onWaehle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left text-sm font-medium transition-colors disabled:opacity-60"
      style={{
        borderColor: rand,
        borderWidth: gewaehlt ? 2 : 1,
        padding: gewaehlt ? "9px 11px" : undefined,
        background: gewaehlt ? "color-mix(in srgb, #ef4444 8%, transparent)" : hover ? "color-mix(in srgb, currentColor 5%, transparent)" : "transparent",
      }}
    >
      <span
        className="h-4 w-4 rounded-full shrink-0 flex items-center justify-center"
        style={{ border: `2px solid ${gewaehlt ? "#ef4444" : "color-mix(in srgb, currentColor 40%, transparent)"}` }}
      >
        {gewaehlt && <span className="h-2 w-2 rounded-full" style={{ background: "#ef4444" }} />}
      </span>
      {label}
    </button>
  );
}
