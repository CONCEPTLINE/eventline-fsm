/**
 * Format-Helfer für den Ablauf-Reiter — Anzeige immer in Europe/Zurich.
 * Ein «Tag» (yyyy-mm-dd) wird zur Mittagszeit gelesen, damit kein
 * Zeitzonen-Sprung den Tag verschiebt.
 */

import { plusTage as plusTageKalender } from "@/lib/swiss-time";

const TZ = "Europe/Zurich";

export function datumKurz(iso: string): string {
  return new Intl.DateTimeFormat("de-CH", { timeZone: TZ, day: "2-digit", month: "2-digit" }).format(new Date(iso));
}

export function datumLang(isoTag: string): string {
  if (!isoTag) return "—";
  const d = new Date(`${isoTag}T12:00:00+01:00`);
  return new Intl.DateTimeFormat("de-CH", {
    timeZone: TZ,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export function datumVoll(isoTag: string): string {
  if (!isoTag) return "—";
  const d = new Date(`${isoTag}T12:00:00+01:00`);
  return new Intl.DateTimeFormat("de-CH", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function zeitstempel(iso: string): string {
  const f = new Intl.DateTimeFormat("de-CH", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return f.format(new Date(iso)).replace(",", "");
}

export function plusTage(isoTag: string, n: number): string {
  return isoTag ? plusTageKalender(isoTag, n) : "";
}

export function chf(n: number): string {
  const ganz = Number.isInteger(n);
  return `CHF ${new Intl.NumberFormat("de-CH", { minimumFractionDigits: ganz ? 0 : 2, maximumFractionDigits: 2 }).format(n)}`;
}

/** «Fr 27.11.» — Wochentag kurz ohne Punkt + Tag/Monat. */
export function tagKurz(isoTag: string): string {
  if (!isoTag) return "—";
  const d = new Date(`${isoTag}T12:00:00+01:00`);
  const wt = new Intl.DateTimeFormat("de-CH", { timeZone: TZ, weekday: "short" }).format(d).replace(".", "");
  return `${wt} ${datumKurz(d.toISOString())}`;
}

/** Uhrzeit «HH:MM» eines Zeitpunkts in Zürich. */
export function uhrzeit(iso: string): string {
  return new Intl.DateTimeFormat("de-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** Kalendertag «yyyy-mm-dd» eines Zeitpunkts in Zürich. */
export function tagZuerich(iso: string): string {
  // en-CA liefert yyyy-mm-dd.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function minuten(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Zeitpunkt (UTC-ISO) für «Tag + HH:MM» in Zürich — mit dem Offset der konkreten Uhrzeit
 * (zuerichZuIso; an Umstellungstagen korrekt). Gleiche Regel wie im Server (src/lib/ablauf/schritte.ts).
 */
export { zuerichIso } from "@/lib/ablauf/schritte";
