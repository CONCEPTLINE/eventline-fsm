export function formatTime(date: string) {
  return new Date(date).toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" });
}

export function formatDate(date: string) {
  return new Date(date).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit" });
}

export function formatDuration(clockIn: string, clockOut: string, breakMin: number) {
  const diff = new Date(clockOut).getTime() - new Date(clockIn).getTime() - breakMin * 60000;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

/**
 * TZ-Suffix fuer den ZIEL-Zeitpunkt — NICHT fuer "jetzt".
 *
 * BUGFIX 2026-09-08 (Leo: "dann sind es einfach andere zeiten"):
 * Vorher wurde der Offset von new Date() (= heute) angehaengt. Wer im
 * September (CEST, +02:00) einen Termin fuer den 27.11. (CET, +01:00)
 * anlegte, speicherte "…T13:00:00+02:00" = 12:00 Winterzeit — der Termin
 * war nach dem Speichern eine Stunde frueher. Gleiches Problem in der
 * Gegenrichtung (Winter → Sommertermin, +1h) und bei toDbDate
 * (Mitternacht-Anker rutschte auf den VORTAG 23:00).
 *
 * Fix: new Date("YYYY-MM-DDTHH:MM:SS") OHNE Suffix wird vom Browser als
 * LOKALE Zeit des Ziel-Zeitpunkts geparst — getTimezoneOffset() liefert
 * dann den am Ziel-Datum gueltigen Offset (DST-korrekt).
 */
function localTzSuffix(date: string, time: string): string {
  const probe = new Date(`${date}T${time}:00`);
  const anchor = Number.isNaN(probe.getTime()) ? new Date() : probe;
  const offset = -anchor.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const m = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}

// Build a timestamptz string anchored to the user's local timezone.
// date: "YYYY-MM-DD", time: "HH:MM" → e.g. "2026-05-11T14:30:00+02:00".
// Postgres timestamptz expects a TZ-suffix; ohne Suffix wird der String als UTC
// interpretiert und Termine landen 1-2h verschoben in der DB.
export function toLocalIsoString(date: string, time: string): string {
  return `${date}T${time}:00${localTzSuffix(date, time)}`;
}

// Heutiges Datum im LOKALEN Kalender als "YYYY-MM-DD".
// new Date().toISOString().split("T")[0] gibt UTC-Datum — nach Mitternacht
// (Schweizer Zeit) liefert es bereits das Datum von gestern bzw. nicht das
// erwartete Datum.
export function todayLocalDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Tages-Datum (YYYY-MM-DD) → timestamptz-String fuer DB-Inserts in Spalten
// die start_date/end_date als timestamptz fuehren. Anchor auf Mitternacht
// LOKAL (mit TZ-Suffix), damit das DB-Datum dem User-eingegebenen Tag
// entspricht. Ohne diesen Cast wird "2026-05-15" als UTC-Mitternacht
// interpretiert → in CEST am Vortag 22:00 (UI zeigt dann den falschen Tag).
// null-safe: null/leer-String bleibt null.
export function toDbDate(date: string | null | undefined): string | null {
  if (!date) return null;
  return toLocalIsoString(date, "00:00");
}
