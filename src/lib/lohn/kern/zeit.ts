// Rechenkern Lohn — Zeit und Kalender (Europe/Zurich).
//
// Rein: keine Datenbank, kein Next.js, keine Importe ausserhalb von
// src/lib/lohn/kern/. Alle Kalendertage sind Schweizer Ortszeit.
//
// Minuten-Zählung: Ein Stempel [start, ende) wird minutengenau auf lokale
// Kalendertage und Stunden verteilt. Gezählt wird die echt gearbeitete Zeit
// (UTC-Differenz), Sommerzeit-Wechsel sind dadurch automatisch richtig
// (März: die übersprungene Stunde fehlt, Oktober: die doppelte zählt zweimal).
// Intern in Stunden-Segmenten: Europe/Zurich hat nur ganzstündige Versätze,
// lokale Stundengrenzen liegen auf UTC-Stundengrenzen.

export const ZEITZONE = "Europe/Zurich";

const datumFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZEITZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const stundeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZEITZONE,
  hour: "2-digit",
  hour12: false,
});

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Lokaler Kalendertag (YYYY-MM-DD) eines Zeitpunkts. */
export function lokalesDatum(ms: number): string {
  return datumFormat.format(new Date(ms));
}

/** Lokale Stunde 0–23 eines Zeitpunkts. */
export function lokaleStunde(ms: number): number {
  return Number(stundeFormat.format(new Date(ms)).split(":")[0]) % 24;
}

/** YYYY-MM-DD + n Tage (reine Kalender-Arithmetik). */
export function plusTage(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Wochentag eines Kalendertags: 0 = Sonntag … 6 = Samstag. */
export function wochentag(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Montag (YYYY-MM-DD) der Woche Montag–Sonntag, in der der Tag liegt. */
export function wochenMontag(iso: string): string {
  return plusTage(iso, -((wochentag(iso) + 6) % 7));
}

/** Monat als Zahl für Vergleiche: jahr*12 + (monat-1). */
export function monatIndex(jahr: number, monat: number): number {
  return jahr * 12 + (monat - 1);
}

export function monatAusIndex(idx: number): { jahr: number; monat: number } {
  return { jahr: Math.floor(idx / 12), monat: (idx % 12) + 1 };
}

export function monatsErster(jahr: number, monat: number): string {
  return `${jahr}-${pad2(monat)}-01`;
}

export function monatsLetzter(jahr: number, monat: number): string {
  const f = monatAusIndex(monatIndex(jahr, monat) + 1);
  return plusTage(monatsErster(f.jahr, f.monat), -1);
}

/** "YYYY-MM" */
export function monatSchluessel(jahr: number, monat: number): string {
  return `${jahr}-${pad2(monat)}`;
}

export function istIsoDatum(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Verteilt [startMs, endeMs) auf lokale Kalendertag-Stunden. Ruft je lokaler
 * Stunde einmal `cb(datum, stunde, minuten)` auf. Minuten-Raster an startMs
 * verankert (angefangene Minute zählt ganz) — identisch zur bisherigen
 * Zählung der App (forEachMinuteSegment).
 */
export function jeLokalerStunde(
  startMs: number,
  endeMs: number,
  cb: (datum: string, stunde: number, minuten: number) => void,
): void {
  if (!(endeMs > startMs)) return;
  let t = startMs;
  while (t < endeMs) {
    const datum = lokalesDatum(t);
    const stunde = lokaleStunde(t);
    const naechsteStunde = (Math.floor(t / 3_600_000) + 1) * 3_600_000;
    const segEnde = Math.min(endeMs, naechsteStunde);
    const n = Math.ceil((segEnde - t) / 60_000);
    cb(datum, stunde, n);
    t += n * 60_000;
  }
}

/** Zeitpunkt (ISO-Text, ms oder Date) → ms; ungültig → NaN. */
export function zuMs(v: string | number | Date): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  return new Date(v).getTime();
}

/**
 * Überlappende Intervalle einer Person zusammenführen (jede Minute zählt nur
 * einmal). Gibt die vereinigten Intervalle und die doppelt gestempelte Zeit
 * (in ms) zurück.
 */
export function vereinige(intervalle: { start: number; ende: number }[]): {
  intervalle: { start: number; ende: number }[];
  doppeltMs: number;
} {
  const sortiert = intervalle
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.ende) && i.ende > i.start)
    .sort((a, b) => a.start - b.start || a.ende - b.ende);
  const out: { start: number; ende: number }[] = [];
  let doppeltMs = 0;
  for (const i of sortiert) {
    const letztes = out[out.length - 1];
    if (letztes && i.start < letztes.ende) {
      doppeltMs += Math.min(letztes.ende, i.ende) - i.start;
      if (i.ende > letztes.ende) letztes.ende = i.ende;
    } else {
      out.push({ start: i.start, ende: i.ende });
    }
  }
  return { intervalle: out, doppeltMs };
}
