// Bausteine für den Kalender-Abo-Feed (RFC 5545), getrennt testbar.
// Benutzt von src/app/api/calendar.ics/route.ts.

const ZUERICH_TAG = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Kalendertag in Zürich als YYYYMMDD (ganztägige Einträge), optional + n Tage.
 * Aufträge speichern start_date/end_date als Zeitpunkt (timestamptz): teils Mitternacht Zürich
 * (= 22:00/23:00 UTC am Vortag), teils 00:00 UTC. Der UTC-Tag wäre im ersten Fall einen Tag zu früh.
 */
export function icsTagZuerich(d: Date, plusTage = 0): string {
  const [j, m, t] = ZUERICH_TAG.format(d).split("-").map(Number);
  const tag = new Date(Date.UTC(j, m - 1, t + plusTage));
  return `${tag.getUTCFullYear()}${pad(tag.getUTCMonth() + 1)}${pad(tag.getUTCDate())}`;
}

/** Zeitpunkt in UTC (YYYYMMDDTHHMMSSZ) — eindeutig, jede Kalender-App rechnet in ihre Zeitzone um. */
export function icsZeitUtc(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes(),
  )}${pad(d.getUTCSeconds())}Z`;
}

/** Ende eines Termins: fehlt es oder liegt es nicht nach dem Start, gilt Start + 1 Stunde (ungültige Einträge
 *  mit Ende vor Start lassen manche Kalender-Apps das ganze Abo verwerfen). */
export function icsEnde(start: Date, ende: Date | null): Date {
  return ende && ende.getTime() > start.getTime() ? ende : new Date(start.getTime() + 60 * 60 * 1000);
}

/** Text-Wert maskieren (RFC 5545 §3.3.11); Zeilenumbrüche jeder Art → \n. */
export function icsText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Zeile nach 75 Bytes falten (RFC 5545 §3.1), ohne ein UTF-8-Zeichen zu zerschneiden. */
export function icsFalten(zeile: string): string {
  const enc = new TextEncoder();
  if (enc.encode(zeile).length <= 75) return zeile;
  const teile: string[] = [];
  let aktuell = "";
  let bytes = 0;
  for (const zeichen of zeile) {
    const n = enc.encode(zeichen).length;
    const max = teile.length === 0 ? 75 : 74; // Folgezeilen beginnen mit einem Leerzeichen
    if (bytes + n > max) {
      teile.push(aktuell);
      aktuell = "";
      bytes = 0;
    }
    aktuell += zeichen;
    bytes += n;
  }
  teile.push(aktuell);
  return teile.join("\r\n ");
}
