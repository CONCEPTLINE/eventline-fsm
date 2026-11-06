"use client";

/**
 * Der «Strahl»: die 5 Schritte des Vermietungs-Ablaufs.
 * grau = noch nicht erreicht · grün mit Haken = erledigt · rot = aktueller Schritt.
 * Laptop-Ansicht: senkrecht links (die Auftragsseite am Handy zeigt den Ablauf nicht).
 */

import { useState } from "react";
import { Check } from "lucide-react";
import { SCHRITTE, type Erledigt, type SchrittNr } from "./konstanten";
import { datumKurz } from "./format";

type Props = {
  erledigt: Erledigt;
  aktuell: number; // 1..5, 6 = alles erledigt
  ausgewaehlt: SchrittNr;
  onSelect: (n: SchrittNr) => void;
};

function zustand(nr: SchrittNr, erledigt: Erledigt, aktuell: number): "erledigt" | "aktuell" | "offen" {
  if (erledigt[nr]) return "erledigt";
  if (nr === aktuell) return "aktuell";
  return "offen";
}

function Kreis({ z, nr }: { z: "erledigt" | "aktuell" | "offen"; nr: number }) {
  const stil =
    z === "erledigt"
      ? { background: "var(--status-green)", borderColor: "var(--status-green)", color: "#fff" }
      : z === "aktuell"
        ? { background: "var(--accent)", borderColor: "var(--accent)", color: "#fff", boxShadow: "0 0 0 4px color-mix(in oklab, var(--accent) 22%, transparent)" }
        : { background: "var(--card)", borderColor: "color-mix(in oklab, var(--foreground) 22%, transparent)", color: "var(--muted-foreground)" };
  return (
    <span className="h-7 w-7 text-xs shrink-0 rounded-full border-2 flex items-center justify-center font-semibold tabular-nums relative z-[1]" style={stil}>
      {z === "erledigt" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : nr}
    </span>
  );
}

export function Strahl({ erledigt, aktuell, ausgewaehlt, onSelect }: Props) {
  const [hover, setHover] = useState<SchrittNr | null>(null);

  return (
    <nav aria-label="Ablauf-Schritte">
      <ol className="relative">
        {SCHRITTE.map((s, i) => {
          const z = zustand(s.nr, erledigt, aktuell);
          const e = erledigt[s.nr];
          const aktiv = ausgewaehlt === s.nr;
          const letzter = i === SCHRITTE.length - 1;
          return (
            <li key={s.nr} className="relative">
              {!letzter && (
                <span
                  aria-hidden
                  className="absolute left-[21px] top-9 bottom-[-6px] w-0.5"
                  style={{ background: e ? "var(--status-green)" : "color-mix(in oklab, var(--foreground) 14%, transparent)" }}
                />
              )}
              <button
                type="button"
                onClick={() => onSelect(s.nr)}
                onMouseEnter={() => setHover(s.nr)}
                onMouseLeave={() => setHover((h) => (h === s.nr ? null : h))}
                aria-current={z === "aktuell" ? "step" : undefined}
                className="w-full flex items-start gap-3 rounded-xl px-2 py-2 mb-1.5 text-left transition-colors"
                style={{
                  background: aktiv
                    ? "var(--card)"
                    : hover === s.nr
                      ? "color-mix(in oklab, var(--foreground) 5%, transparent)"
                      : "transparent",
                  boxShadow: aktiv ? "0 1px 2px rgba(0,0,0,0.06)" : undefined,
                }}
              >
                <Kreis z={z} nr={s.nr} />
                <span className="min-w-0 pt-0.5">
                  <span className={`block text-sm leading-tight ${z === "offen" ? "text-muted-foreground" : "font-semibold"}`}>
                    {s.titel}
                  </span>
                  <span className="block text-[11px] text-muted-foreground mt-0.5">
                    {e ? (e.zeit ? `erledigt ${datumKurz(e.zeit)} · ${e.quelle}` : "erledigt") : z === "aktuell" ? "jetzt dran" : "noch nicht erreicht"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
