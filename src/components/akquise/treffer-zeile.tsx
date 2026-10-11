"use client";

/**
 * Eine Zeile der Akquise-Trefferliste — als Spaltenraster, nicht als Karte:
 * Score, Name, Ort, Kapazität, Modell und Potenzial stehen untereinander
 * ausgerichtet, damit sich Kandidaten zeilenweise vergleichen lassen.
 *
 * Hover über die app-weite Klasse `.row-hover` (globals.css); die
 * Auswahl-Markierung bleibt inline, weil sie Zustand ist, nicht Hover.
 */

import { useState } from "react";
import { Pin, Globe, Wrench } from "lucide-react";
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

/** Spaltenraster — Kopfzeile und Zeilen teilen es sich, sonst verrutschen sie. */
export const SPALTEN =
  "grid grid-cols-[2.5rem_minmax(0,2.2fr)_minmax(0,1fr)_4rem_minmax(0,1.3fr)_6rem_2rem] items-center gap-2";

/** Eine Kopfspalte. Bewusst ausserhalb von TrefferKopf definiert — eine
 *  im Render erzeugte Komponente würde React bei jedem Durchlauf neu
 *  mounten und den Fokus/Zustand darunter verlieren. */
function KopfSpalte({
  feld, sortierung, onSortieren, rechts = false, children,
}: {
  feld?: string;
  sortierung: string;
  onSortieren: (feld: string) => void;
  rechts?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={!feld}
      onClick={() => feld && onSortieren(feld)}
      className={`text-[10px] font-semibold uppercase tracking-wider transition-colors ${
        rechts ? "text-right" : "text-left"
      } ${feld ? "cursor-pointer hover:text-foreground" : "cursor-default"} ${
        sortierung === feld ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      {children}
      {sortierung === feld && " \u2193"}
    </button>
  );
}

export function TrefferKopf({
  sortierung, onSortieren,
}: {
  sortierung: string;
  onSortieren: (feld: string) => void;
}) {
  const p = { sortierung, onSortieren };
  return (
    <div className={`${SPALTEN} border-b border-border px-2.5 py-1.5`}>
      <KopfSpalte feld="score" {...p}>Score</KopfSpalte>
      <KopfSpalte feld="name" {...p}>Location</KopfSpalte>
      <KopfSpalte feld="ort" {...p}>Ort</KopfSpalte>
      <KopfSpalte feld="kapazitaet" rechts {...p}>Plätze</KopfSpalte>
      <KopfSpalte {...p}>Modell</KopfSpalte>
      <KopfSpalte feld="rentabilitaet" rechts {...p}>CHF/Jahr</KopfSpalte>
      <span />
    </div>
  );
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
      className={`${SPALTEN} cursor-pointer rounded-md px-2.5 py-2 [--row-hover-x:0.125rem] ${
        ausgewaehlt ? "" : "row-hover"
      }`}
      style={ausgewaehlt ? { backgroundColor: "rgba(37, 99, 235, 0.10)" } : undefined}
    >
      <span className={`text-sm font-semibold tabular-nums ${scoreTon(location.score)}`}>
        {location.score ?? "—"}
      </span>

      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{location.name}</p>
        {/* Zweite Zeile zeigt den Ansprechpartner, sobald er belegt ist —
            das ist die Angabe, die einen Treffer anrufbar macht. */}
        <p className="truncate text-[11px] text-muted-foreground">
          {location.ansprechperson
            ? <span className="text-foreground/70">{location.ansprechperson}
                {location.position && <span className="text-muted-foreground"> · {location.position}</span>}
              </span>
            : (location.typ ?? "Location")}
        </p>
      </div>

      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">{location.ort}</span>
        {location.website && (
          <a
            href={location.website} target="_blank" rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            data-tooltip={location.website}
            aria-label="Website öffnen"
            className="shrink-0 text-blue-600 hover:underline dark:text-blue-400"
          >
            <Globe className="h-3 w-3" />
          </a>
        )}
      </span>

      <span className="text-right text-xs tabular-nums text-muted-foreground">
        {location.kapazitaet ?? "—"}
      </span>

      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">
          {location.empfohlenes_modell === "keins" ? "—" : modellLabel(location.empfohlenes_modell)}
        </span>
        {((location.techniker_im_team ?? 0) > 0 || location.technikpartner === "ja") && (
          <Wrench
            className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
            data-tooltip={location.techniker_im_team
              ? `${location.techniker_im_team} eigene Techniker — Technikmodell fällt weg`
              : "Fester Technikpartner vorhanden"}
          />
        )}
      </span>

      <span className="text-right text-xs font-medium tabular-nums">
        {location.rentabilitaet_chf !== null && location.rentabilitaet_chf > 0
          ? chf(location.rentabilitaet_chf)
          : <span className="text-muted-foreground">—</span>}
      </span>

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onPin(); }}
        onMouseEnter={() => setPinHover(true)}
        onMouseLeave={() => setPinHover(false)}
        data-tooltip={angepinnt ? "Pin entfernen" : "Anpinnen"}
        aria-label={angepinnt ? "Pin entfernen" : "Anpinnen"}
        className="justify-self-center rounded p-1 transition-colors"
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
  );
}
