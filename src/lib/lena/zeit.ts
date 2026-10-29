// Zeit-Helfer fuer die Telefonassistentin «Lena» (/api/lena/*).
//
// Server laufen auf Vercel in UTC — die Browser-Helfer aus src/lib/format.ts
// (toLocalIsoString, getTimezoneOffset) wuerden hier UTC statt Schweizer Zeit
// nehmen. Deshalb rechnet dieses Modul ausschliesslich ueber
// Intl.DateTimeFormat(timeZone: "Europe/Zurich") — DST-korrekt, unabhaengig
// von der Zeitzone des Servers. Rein, ohne Server-Importe (Unit-Tests).

export const ZRH = "Europe/Zurich";

const TAG_MS = 86_400_000;
const WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;

const teileFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZRH,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export type ZurichTeile = {
  jahr: number;
  monat: number;
  tag: number;
  stunde: number;
  minute: number;
  sekunde: number;
  /** 0 = Sonntag … 6 = Samstag */
  wochentag: number;
  /** YYYY-MM-DD im Schweizer Kalender */
  datum: string;
};

/** Ein Zeitpunkt (ms seit Epoch) zerlegt in Schweizer Lokalzeit. */
export function zurichTeile(ms: number): ZurichTeile {
  const p: Record<string, string> = {};
  for (const t of teileFormat.formatToParts(new Date(ms))) p[t.type] = t.value;
  const jahr = Number(p.year);
  const monat = Number(p.month);
  const tag = Number(p.day);
  return {
    jahr,
    monat,
    tag,
    stunde: Number(p.hour) % 24,
    minute: Number(p.minute),
    sekunde: Number(p.second),
    wochentag: new Date(Date.UTC(jahr, monat - 1, tag)).getUTCDay(),
    datum: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Abstand Schweizer Lokalzeit − UTC in Minuten (+60 Winter, +120 Sommer). */
function zurichOffsetMin(ms: number): number {
  const ganz = ms - (((ms % 1000) + 1000) % 1000);
  const t = zurichTeile(ganz);
  const alsUtc = Date.UTC(t.jahr, t.monat - 1, t.tag, t.stunde, t.minute, t.sekunde);
  return Math.round((alsUtc - ganz) / 60_000);
}

/** Schweizer Wandzeit → Zeitpunkt (ms). DST-korrekt; in der Luecke der
 *  Sommerzeit-Umstellung (02:00–03:00 im Maerz) liefert es den Zeitpunkt
 *  eine Stunde spaeter, in der doppelten Stunde (Oktober) die zweite
 *  (Winterzeit). */
export function zurichWandzeitZuMs(
  jahr: number,
  monat: number,
  tag: number,
  stunde = 0,
  minute = 0,
  sekunde = 0,
): number {
  const schaetzung = Date.UTC(jahr, monat - 1, tag, stunde, minute, sekunde);
  const off1 = zurichOffsetMin(schaetzung);
  const ms = schaetzung - off1 * 60_000;
  const off2 = zurichOffsetMin(ms);
  return off2 === off1 ? ms : schaetzung - off2 * 60_000;
}

/** Mitternacht (Beginn) eines Schweizer Kalendertags YYYY-MM-DD. */
export function zurichMitternacht(datum: string): number {
  const [j, m, t] = datum.split("-").map(Number);
  return zurichWandzeitZuMs(j, m, t);
}

/** YYYY-MM-DD + n Tage (reine Kalender-Arithmetik). */
export function datumPlusTage(datum: string, n: number): string {
  const [j, m, t] = datum.split("-").map(Number);
  const d = new Date(Date.UTC(j, m - 1, t + n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Ist YYYY-MM-DD ein echter Kalendertag (2000–2100)? */
export function gueltigesDatum(jahr: number, monat: number, tag: number): boolean {
  if (jahr < 2000 || jahr > 2100 || monat < 1 || monat > 12 || tag < 1) return false;
  const d = new Date(Date.UTC(jahr, monat - 1, tag));
  return d.getUTCFullYear() === jahr && d.getUTCMonth() === monat - 1 && d.getUTCDate() === tag;
}

export type Zeitpunkt = {
  ms: number;
  /** true = nur ein Datum ohne Uhrzeit (Beginn des Schweizer Tages) */
  nurDatum: boolean;
  /** Schweizer Kalendertag YYYY-MM-DD des Zeitpunkts */
  datum: string;
};

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** ISO-Datum oder -Zeitpunkt lesen.
 *  - "2026-10-30"                → Beginn des Tages (Schweizer Zeit), nurDatum
 *  - "2026-10-30T10:00"          → 10:00 Schweizer Zeit (ohne Zeitzone = lokal)
 *  - "2026-10-30T09:00:00Z" / "+01:00" → genau dieser Zeitpunkt
 *  Alles andere (falsche Form, unmoeglicher Tag, Jahr ausser 2000–2100) → null. */
export function parseZeitpunkt(roh: unknown): Zeitpunkt | null {
  if (typeof roh !== "string") return null;
  const s = roh.trim();
  if (s.length === 0 || s.length > 40) return null;
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const jahr = Number(m[1]);
  const monat = Number(m[2]);
  const tag = Number(m[3]);
  if (!gueltigesDatum(jahr, monat, tag)) return null;
  if (m[4] === undefined) {
    const datum = `${m[1]}-${m[2]}-${m[3]}`;
    return { ms: zurichMitternacht(datum), nurDatum: true, datum };
  }
  const stunde = Number(m[4]);
  const minute = Number(m[5]);
  const sekunde = m[6] === undefined ? 0 : Number(m[6]);
  if (stunde > 23 || minute > 59 || sekunde > 59) return null;
  let ms: number;
  const zone = m[7];
  if (zone === undefined) {
    ms = zurichWandzeitZuMs(jahr, monat, tag, stunde, minute, sekunde);
  } else {
    let offMin = 0;
    if (zone.toUpperCase() !== "Z") {
      const ziffern = zone.slice(1).replace(":", "");
      const h = Number(ziffern.slice(0, 2));
      const mi = ziffern.length > 2 ? Number(ziffern.slice(2, 4)) : 0;
      if (h > 14 || mi > 59) return null;
      offMin = (zone[0] === "-" ? -1 : 1) * (h * 60 + mi);
    }
    ms = Date.UTC(jahr, monat - 1, tag, stunde, minute, sekunde) - offMin * 60_000;
  }
  return { ms, nurDatum: false, datum: zurichTeile(ms).datum };
}

const zwei = (n: number) => String(n).padStart(2, "0");

/** «Fr 30.10.» — mit Jahr («Sa 30.10.2027»), wenn es nicht das laufende ist. */
export function formatTag(ms: number, jetztMs: number): string {
  const t = zurichTeile(ms);
  const jahr = t.jahr === zurichTeile(jetztMs).jahr ? "" : String(t.jahr);
  return `${WOCHENTAG[t.wochentag]} ${zwei(t.tag)}.${zwei(t.monat)}.${jahr}`;
}

/** «10:00» in Schweizer Zeit. */
export function formatUhrzeit(ms: number): string {
  const t = zurichTeile(ms);
  return `${zwei(t.stunde)}:${zwei(t.minute)}`;
}

/** «Fr 30.10. 10:00–11:00» · ohne/ungueltiges Ende «Fr 30.10. 10:00» ·
 *  ueber Mitternacht «Fr 30.10. 22:00 – Sa 31.10. 02:00». */
export function formatZeitraum(startMs: number, endeMs: number | null, jetztMs: number): string {
  const beginn = `${formatTag(startMs, jetztMs)} ${formatUhrzeit(startMs)}`;
  if (endeMs === null || !(endeMs > startMs)) return beginn;
  if (zurichTeile(endeMs).datum === zurichTeile(startMs).datum) return `${beginn}–${formatUhrzeit(endeMs)}`;
  return `${beginn} – ${formatTag(endeMs, jetztMs)} ${formatUhrzeit(endeMs)}`;
}

export { TAG_MS };
