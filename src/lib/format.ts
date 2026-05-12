export function formatTime(date: string) {
  return new Date(date).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(date: string) {
  return new Date(date).toLocaleDateString("de-CH", { weekday: "short", day: "2-digit", month: "2-digit" });
}

export function formatDuration(clockIn: string, clockOut: string, breakMin: number) {
  const diff = new Date(clockOut).getTime() - new Date(clockIn).getTime() - breakMin * 60000;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function localTzSuffix(): string {
  const offset = -new Date().getTimezoneOffset();
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
  return `${date}T${time}:00${localTzSuffix()}`;
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
