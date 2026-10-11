// Gemeinsame Format-Helfer des Buero-Bildschirms (2026-10-11): Todos und
// «Zuletzt passiert» zeigen Datum, Uhrzeit und Vornamen gleich. Nur im
// Browser gebraucht, bewusst ohne Imports. Zeitanzeige immer Europe/Zurich.

export const ZRH = "Europe/Zurich";
const WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
/** Intl statt toLocaleTimeString (gleiche Ausgabe, einmal gebaut). */
const UHRZEIT = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit" });

/** YYYY-MM-DD als reines Kalenderdatum (UTC-Mitternacht) — keine Zeitzone im Spiel. */
export function kalender(iso: string): Date {
  const [j, m, t] = iso.split("-").map(Number);
  return new Date(Date.UTC(j, m - 1, t));
}

/** YYYY-MM-DD → "Di 6.10." */
export function kurzDatum(iso: string): string {
  const d = kalender(iso);
  return `${WOCHENTAG[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
}

/** ISO-Zeitpunkt → "13:33" (Zurich). */
export function uhrzeit(iso: string): string {
  return UHRZEIT.format(new Date(iso));
}

export function vorname(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
