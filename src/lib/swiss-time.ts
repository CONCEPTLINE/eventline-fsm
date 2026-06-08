/**
 * Schweizer-Zeit-Helper — ALLE Zeit-Berechnungen die mit Lokal-Kalender
 * arbeiten (Lohn, Stempel, Nacht-/Sonntag-Detection) MUESSEN diese
 * Helpers nutzen damit DST korrekt behandelt wird und der Code
 * konsistent bleibt.
 *
 * Warum: Date.getTime() + 60_000-Iteration in UTC durchzaehlen ist
 * unsauber wenn man Lokal-Stunden braucht — am DST-Vorlauf-Tag (Maerz)
 * fehlt eine Stunde, am Rueckschritt-Tag (Oktober) ist eine doppelt.
 * Per-Minute-Bucketing mit Intl.DateTimeFormat(timeZone='Europe/Zurich')
 * pro Iteration gibt dann das richtige Lokal-Datum + Stunde.
 *
 * KONVENTION: stempelMin sollte NIE aus (clock_out - clock_in)/60000
 * berechnet werden — das ist UTC-Delta. Stattdessen: sum der Minuten
 * die per-Minute-Bucketize jedem Datum zuordnet → automatisch DST-safe.
 */

export const ZRH_TZ = "Europe/Zurich";

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZRH_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const hourFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZRH_TZ,
  hour: "2-digit",
  hour12: false,
});
const weekdayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ZRH_TZ,
  weekday: "short",
});
const timeHMFormat = new Intl.DateTimeFormat("de-CH", {
  timeZone: ZRH_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** YYYY-MM-DD im Europe/Zurich-Lokal-Kalender. */
export function localDateIso(d: Date): string {
  return dateFormat.format(d);
}

/** Stunde 0-23 im Lokal-Kalender (DST-korrekt). */
export function localHour(d: Date): number {
  return Number(hourFormat.format(d).split(":")[0]);
}

/** Wochentag 0-6 (Sonntag=0, Samstag=6) im Lokal-Kalender. */
export function localWeekday(d: Date): number {
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekdayFormat.format(d)] ?? 0;
}

/** "HH:MM" im Lokal-Kalender. */
export function localTimeHM(d: Date): string {
  return timeHMFormat.format(d);
}

/** Wochentag-Bestimmung anhand eines Date-Strings YYYY-MM-DD.
 *  Mittag-Zeit damit DST-Edge-Cases vermieden werden (00:00 koennte
 *  bei DST-Wechsel mehrdeutig sein). */
export function weekdayForDateIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return localWeekday(noonUtc);
}

export interface MinuteBucket {
  /** YYYY-MM-DD (lokal) — der Tag auf dem die Minute angefallen ist. */
  date: string;
  /** Gesamt-Minuten auf diesem Tag (= Stempel-Minuten). */
  total_minutes: number;
  /** Davon im Nacht-Fenster (Lokal-Stunde >=23 oder <6). */
  night_minutes: number;
}

/**
 * Iteriert minutenweise durch ein Intervall [start, end) und gruppiert
 * die Minuten nach LOKAL-DATUM (Zurich). DST-safe.
 *
 * Beispiel: Schicht Sa 22:00 → So 03:00 ergibt 2 Buckets:
 *   { date: "2026-05-30", total: 120, night: 60 }   (22-24, davon 23-24 Nacht)
 *   { date: "2026-05-31", total: 180, night: 180 }  (00-03, alles Nacht)
 *
 * Bei DST-Vorlauf (Ende Maerz): 02:00 springt auf 03:00. Die fehlende
 * Stunde wird NICHT gezaehlt (UTC-Delta ist kleiner als Anzahl
 * Lokal-Sekunden) — automatisch korrekt.
 */
export function bucketizeMinutes(
  startMs: number,
  endMs: number,
  perDate: Map<string, MinuteBucket>,
) {
  if (endMs <= startMs) return;
  for (let t = startMs; t < endMs; t += 60_000) {
    const d = new Date(t);
    const date = localDateIso(d);
    let b = perDate.get(date);
    if (!b) {
      b = { date, total_minutes: 0, night_minutes: 0 };
      perDate.set(date, b);
    }
    b.total_minutes++;
    const h = localHour(d);
    if (h >= 23 || h < 6) b.night_minutes++;
  }
}

/** Heutiges Datum YYYY-MM-DD im Lokal-Kalender. */
export function todayLocalIso(): string {
  return localDateIso(new Date());
}
