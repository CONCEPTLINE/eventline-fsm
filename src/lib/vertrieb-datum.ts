import { todayLocalIso, ZRH_TZ } from "@/lib/swiss-time";

/** Wie dringend ist der naechste Schritt? Steuert die Farbe in der Liste. */
export type Faelligkeit = "ueberfaellig" | "heute" | "spaeter" | "keins";

export function faelligkeit(datum: string | null): Faelligkeit {
  if (!datum) return "keins";
  const heute = todayLocalIso();
  // ISO-Strings (YYYY-MM-DD) lassen sich direkt vergleichen.
  if (datum < heute) return "ueberfaellig";
  if (datum === heute) return "heute";
  return "spaeter";
}

/** "Mi, 29.10." — Date-Only, darum Mittag UTC: so kippt kein Tag (§4). */
export function datumKurz(datum: string): string {
  const [y, m, d] = datum.split("-").map(Number);
  return new Intl.DateTimeFormat("de-CH", {
    timeZone: ZRH_TZ, weekday: "short", day: "2-digit", month: "2-digit",
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
