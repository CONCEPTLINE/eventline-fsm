// Bexio-Werte → Postgres-Eingaben (Finanzen Welle 1).
//
// Beträge werden als STRINGS durchgereicht (numeric in Postgres — keine
// Float-Rundung), Datumsfelder auf 'YYYY-MM-DD' gekürzt, Bexio-Zeiten ohne
// Zeitzone als Europe/Zurich interpretiert (ANNAHME G.1 — die 26-h-
// Überlappung im Delta macht die Annahme unkritisch).

import { todayLocalIso } from "@/lib/swiss-time";

/** Betrag → String für numeric. string → trim, number → String(v), sonst null. */
export function zahl(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return null;
}

/** 'YYYY-MM-DD…' (Datum, Bexio-Zeit oder ISO mit Offset) → 'YYYY-MM-DD'.
 *  Reiner Textschnitt auf den Kalendertag, den Bexio liefert — KEINE
 *  Zeitzonen-Umrechnung (date-Spalten). */
export function datum(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}

const BEXIO_ZEIT_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/;
const ISO_MIT_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** Bexio 'YYYY-MM-DD HH:MM:SS' (ohne Zeitzone) → timestamptz-Eingabe
 *  `'YYYY-MM-DD HH:MM:SS Europe/Zurich'` (Postgres interpretiert den
 *  Zonennamen DST-korrekt). ISO mit Offset geht unverändert durch. */
export function bexioZeitNachTz(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const m = BEXIO_ZEIT_RE.exec(t);
  if (m) return `${m[1]} ${m[2]} Europe/Zurich`;
  if (ISO_MIT_OFFSET_RE.test(t)) return t;
  return null;
}

const suchZeitFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Date → 'YYYY-MM-DD HH:MM:SS' in Europe/Zurich — der Suchwert für
 *  `updated_at greater_than`. Über formatToParts zusammengesetzt, NICHT
 *  format() (en-CA liefert «2026-10-15, 04:30:00» mit Komma). */
export function bexioSuchZeit(d: Date): string {
  const teile: Record<string, string> = {};
  for (const p of suchZeitFormat.formatToParts(d)) {
    if (p.type !== "literal") teile[p.type] = p.value;
  }
  // hourCycle h23 liefert "00".."23"; Browser-/Node-Abweichungen ("24")
  // abfangen.
  const stunde = teile.hour === "24" ? "00" : teile.hour;
  return `${teile.year}-${teile.month}-${teile.day} ${stunde}:${teile.minute}:${teile.second}`;
}

/** Heutiges Datum YYYY-MM-DD in Zürich (= todayLocalIso, kein Eigenbau). */
export function istZuerichHeute(): string {
  return todayLocalIso();
}
