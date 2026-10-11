"use client";

/**
 * Eine Zeile der Akquise-Trefferliste. Hover über die app-weite Klasse
 * `.card-hover` (globals.css) — seit der Vereinheitlichung vom 2026-10-11
 * das kanonische Rezept für Karten, die als Ganzes klickbar sind. Nur die
 * Auswahl-Markierung bleibt inline, weil sie Zustand ist, nicht Hover.
 */

import { useState } from "react";
import { Pin, Handshake } from "lucide-react";
import { KOOPERATIONS_MODELLE, chf } from "@/lib/akquise-faktoren";
import type { AkquiseLocation } from "@/types/akquise";

/** Score-Farbe in Stufen — gleiche Bedeutung, gleiche Farbe app-weit (§2). */
export function scoreTon(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 70) return "text-green-600 dark:text-green-400";
  if (score >= 45) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

export function modellLabel(key: string | null): string {
  if (!key) return "—";
  return KOOPERATIONS_MODELLE.find((m) => m.key === key)?.label ?? key;
}

export function TrefferZeile({
  location, ausgewaehlt, onClick, onPin,
}: {
  location: AkquiseLocation;
  ausgewaehlt: boolean;
  onClick: () => void;
  onPin: () => void;
}) {
  const [pinHover, setPinHover] = useState(false);
  const angepinnt = location.angepinnt_am !== null;

  return (
    <div
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-2 cursor-pointer ${ausgewaehlt ? "" : "card-hover"}`}
      style={{
        borderColor: ausgewaehlt ? "var(--status-blue)" : "var(--border)",
        backgroundColor: ausgewaehlt ? "rgba(37, 99, 235, 0.10)" : "transparent",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium truncate">{location.name}</p>
          <p className="text-[11px] text-muted-foreground truncate">
            {location.typ ?? "Location"} · {location.ort}
            {location.kapazitaet !== null && ` · ${location.kapazitaet} Pl.`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-sm font-semibold tabular-nums ${scoreTon(location.score)}`}>
            {location.score ?? "—"}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPin(); }}
            onMouseEnter={() => setPinHover(true)}
            onMouseLeave={() => setPinHover(false)}
            data-tooltip={angepinnt ? "Pin entfernen" : "Anpinnen"}
            aria-label={angepinnt ? "Pin entfernen" : "Anpinnen"}
            className="rounded p-0.5 transition-colors"
            style={{ backgroundColor: pinHover ? "var(--muted)" : "transparent" }}
          >
            <Pin
              className="h-3.5 w-3.5"
              style={{
                color: angepinnt ? "var(--status-amber)" : "var(--muted-foreground)",
                fill: angepinnt ? "var(--status-amber)" : "none",
              }}
            />
          </button>
        </div>
      </div>
      {location.empfohlenes_modell && location.empfohlenes_modell !== "keins" && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px]">
          <Handshake className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground">
            {modellLabel(location.empfohlenes_modell)}
          </span>
          {location.rentabilitaet_chf !== null && location.rentabilitaet_chf > 0 && (
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
              {chf(location.rentabilitaet_chf)} CHF/J.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
