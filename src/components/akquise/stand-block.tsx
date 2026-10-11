"use client";

/**
 * Wo steht dieser Kandidat, und wann wird nachgehakt?
 *
 * Bewusst klein: vier Stufen, ein Datum, ein Notizfeld. Leo und Mischa
 * schaffen rund eine Location pro Tag — eine Liste von zwanzig ist vier
 * Wochen Arbeit, in denen man ohne Festhalten den Faden verliert. Eine
 * Pipeline mit zehn Stufen und Pflichtfeldern würde dabei mehr kosten
 * als helfen.
 *
 * Alles speichert sofort beim Klick bzw. beim Verlassen des Feldes —
 * kein Speichern-Knopf, den man vergessen kann.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { AkquiseLocation } from "@/types/akquise";

const STUFEN = [
  { key: "neu", label: "Neu" },
  { key: "angeschrieben", label: "Angeschrieben" },
  { key: "gespraech", label: "Im Gespräch" },
  { key: "abgehakt", label: "Abgehakt" },
] as const;

/** Heute in Zürcher Zeit als ISO-Datum (§4: nie ohne timeZone). */
function heute(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
}

export function StandBlock({
  location, onAendern,
}: {
  location: AkquiseLocation;
  onAendern: (patch: Partial<AkquiseLocation>) => Promise<void>;
}) {
  const [speichert, setSpeichert] = useState(false);

  async function setzen(patch: Partial<AkquiseLocation>) {
    setSpeichert(true);
    try {
      await onAendern(patch);
    } catch {
      toast.error("Speichern fehlgeschlagen");
    } finally {
      setSpeichert(false);
    }
  }

  const faellig =
    location.wiedervorlage_am !== null &&
    location.wiedervorlage_am <= heute() &&
    location.stand !== "abgehakt";

  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/55">Stand</p>
        {speichert && <Loader2 className="h-3 w-3 animate-spin text-foreground/50" />}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STUFEN.map((st) => (
          <button
            key={st.key}
            type="button"
            onClick={() => void setzen({
              stand: st.key,
              // Beim Anschreiben gleich in zehn Tagen nachhaken — das ist
              // der Rhythmus, in dem man sonst nachfragt, und erspart das
              // Datum von Hand zu setzen.
              ...(st.key === "angeschrieben" && !location.wiedervorlage_am
                ? { wiedervorlage_am: inTagen(10) }
                : {}),
            })}
            className={`kasten text-xs ${location.stand === st.key ? "kasten-blue" : "kasten-muted"}`}
          >
            {st.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="wv" className="text-[13px] text-foreground/65">Nachhaken am</label>
        <input
          id="wv"
          type="date"
          value={location.wiedervorlage_am ?? ""}
          onChange={(e) => void setzen({ wiedervorlage_am: e.target.value || null })}
          className={`h-8 rounded-md border bg-background px-2 text-[13px] ${
            faellig ? "border-red-400 text-red-700 dark:text-red-400" : "border-border"
          }`}
        />
        {faellig && <span className="text-[13px] font-medium text-red-700 dark:text-red-400">fällig</span>}
      </div>

      {/* Das Wertvollste hier: was im Gespräch gesagt wurde, ist
          belastbarer als jede Website-Recherche. */}
      <textarea
        defaultValue={location.gespraechsnotiz ?? ""}
        onBlur={(e) => {
          const wert = e.target.value.trim();
          if (wert !== (location.gespraechsnotiz ?? "")) {
            void setzen({ gespraechsnotiz: wert || null });
          }
        }}
        rows={3}
        placeholder="Notizen aus dem Gespräch — wer entscheidet, was sie brauchen, was vereinbart wurde…"
        className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm leading-relaxed"
      />
    </section>
  );
}

/** ISO-Datum in n Tagen, in Zürcher Zeit. */
function inTagen(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(d);
}
