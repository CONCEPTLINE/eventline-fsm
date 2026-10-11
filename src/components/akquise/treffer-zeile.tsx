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
import { Pin, Globe, Wrench, FolderCheck } from "lucide-react";
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

/**
 * Die Liste ist 22rem schmal — sieben Spalten passen da nicht hinein,
 * die Namen wurden zu "R…" abgeschnitten. Deshalb jetzt zwei Zeilen je
 * Treffer: oben Score und Name, unten die Einordnung. Lesbar schlaegt
 * vollstaendig.
 */
/** Sortierknopf. Ausserhalb von TrefferKopf, weil eine im Render
 *  erzeugte Komponente React bei jedem Durchlauf neu mounten würde. */
function SortKnopf({ feld, aktiv, onSortieren, children }: {
  feld: string;
  aktiv: boolean;
  onSortieren: (feld: string) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onSortieren(feld)}
      className={`transition-colors hover:text-foreground ${aktiv ? "font-semibold text-foreground" : ""}`}
    >
      {children}{aktiv && " ↓"}
    </button>
  );
}

export function TrefferKopf({
  sortierung, onSortieren,
}: {
  sortierung: string;
  onSortieren: (feld: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wide text-foreground/65">
      <SortKnopf feld="score" aktiv={sortierung === "score"} onSortieren={onSortieren}>Score</SortKnopf>
      <SortKnopf feld="name" aktiv={sortierung === "name"} onSortieren={onSortieren}>Name</SortKnopf>
      <SortKnopf feld="kapazitaet" aktiv={sortierung === "kapazitaet"} onSortieren={onSortieren}>Plätze</SortKnopf>
      <SortKnopf feld="rentabilitaet" aktiv={sortierung === "rentabilitaet"} onSortieren={onSortieren}>CHF</SortKnopf>
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
  const technikBesetzt =
    (location.techniker_im_team ?? 0) > 0 || location.technikpartner === "ja";
  const faellig =
    location.wiedervorlage_am !== null &&
    location.wiedervorlage_am <= heute() &&
    location.stand !== "abgehakt";

  return (
    <div
      onClick={onClick}
      className={`cursor-pointer rounded-md px-3 py-2 [--row-hover-x:0.125rem] ${
        ausgewaehlt ? "" : "row-hover"
      }`}
      style={ausgewaehlt ? { backgroundColor: "rgba(37, 99, 235, 0.10)" } : undefined}
    >
      {/* Zeile 1: Score, Name, Pin */}
      <div className="flex items-baseline gap-2">
        <span className={`w-7 shrink-0 text-base font-bold tabular-nums ${scoreTon(location.score)}`}>
          {location.score ?? "—"}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={location.name}>
          {location.name}
        </span>
        {location.projekt_id && (
          <FolderCheck className="h-3.5 w-3.5 shrink-0 text-green-700 dark:text-green-400"
                       data-tooltip="Wird als Projekt verfolgt" />
        )}
        {location.prioritaet && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold ${
            location.prioritaet === "A" ? "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300"
            : location.prioritaet === "B" ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
            : "bg-muted text-foreground/70"
          }`}>
            {location.prioritaet}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPin(); }}
          onMouseEnter={() => setPinHover(true)}
          onMouseLeave={() => setPinHover(false)}
          data-tooltip={angepinnt ? "Pin entfernen" : "Anpinnen"}
          aria-label={angepinnt ? "Pin entfernen" : "Anpinnen"}
          className="shrink-0 rounded p-0.5 transition-colors"
          style={{ backgroundColor: pinHover ? "var(--muted)" : "transparent" }}
        >
          <Pin className="h-3.5 w-3.5" style={{
            color: angepinnt ? "var(--status-amber)" : "var(--muted-foreground)",
            fill: angepinnt ? "var(--status-amber)" : "none",
          }} />
        </button>
      </div>

      {/* Zeile 2: Einordnung */}
      <div className="mt-0.5 flex items-center gap-2 pl-9 text-[12px] text-foreground/70">
        {/* Fälliges zuerst — sonst übersieht man es in einer Liste, die
            man über vier Wochen abarbeitet. */}
        {faellig && (
          <span className="shrink-0 rounded bg-red-100 px-1.5 font-semibold text-red-800 dark:bg-red-500/20 dark:text-red-300">
            fällig
          </span>
        )}
        {location.stand !== "neu" && !faellig && (
          <span className="shrink-0 text-foreground/55">{STAND_KURZ[location.stand]}</span>
        )}
        <span className="truncate">{location.ort}</span>
        {location.kapazitaet !== null && (
          <span className="shrink-0 tabular-nums">· {location.kapazitaet} Pl.</span>
        )}
        {location.empfohlenes_modell && location.empfohlenes_modell !== "keins" && (
          <span className="shrink-0">· {modellKurz(location.empfohlenes_modell)}</span>
        )}
        {technikBesetzt && (
          <Wrench className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                  data-tooltip="Technik ist besetzt" />
        )}
        {location.rentabilitaet_chf !== null && location.rentabilitaet_chf > 0 && (
          <span className="ml-auto shrink-0 font-medium tabular-nums text-foreground">
            {chf(location.rentabilitaet_chf)}
          </span>
        )}
        {location.website && (
          <a href={location.website} target="_blank" rel="noopener noreferrer"
             onClick={(e) => e.stopPropagation()}
             aria-label="Website öffnen"
             className="shrink-0 text-blue-700 hover:underline dark:text-blue-400">
            <Globe className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

/** Heute in Zürcher Zeit als ISO-Datum (§4: nie ohne timeZone). */
function heute(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
}

const STAND_KURZ: Record<string, string> = {
  angeschrieben: "angeschrieben",
  gespraech: "im Gespräch",
  abgehakt: "abgehakt",
};

/** Kurzform des Modells für die schmale Liste: «A», «B», «C». */
function modellKurz(key: string): string {
  const label = KOOPERATIONS_MODELLE.find((m) => m.key === key)?.label ?? key;
  return label.split(" ")[0];
}
