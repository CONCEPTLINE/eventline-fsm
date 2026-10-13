// Technik-Dashboard: Zahlen, Zeiten und Groessen fuer die Anzeige.
// Zeiten immer in Europe/Zurich (CLAUDE.md §4). Zahlen wie im Entwurf mit Komma.
// Platten/NAS dezimal (1 GB = 10^9 B), Arbeits-/Grafikspeicher binaer mit «GB» beschriftet (VERTRAG §6.4).

import { ZRH_TZ } from "@/lib/swiss-time";

const fHM = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fHMS = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const fTag = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, day: "2-digit", month: "2-digit" });
const fDatum = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, day: "2-digit", month: "2-digit", year: "numeric" });
const fWt = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, weekday: "short" });
const fYmd = new Intl.DateTimeFormat("en-CA", { timeZone: ZRH_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fStunde = new Intl.DateTimeFormat("en-GB", { timeZone: ZRH_TZ, hour: "2-digit", hourCycle: "h23" });

type Zeit = string | number | Date;
const alsDate = (z: Zeit) => (z instanceof Date ? z : new Date(z));
const gueltig = (z: Zeit | null | undefined): z is Zeit => z != null && !Number.isNaN(alsDate(z).getTime());

/** Zahl mit Komma: komma(4.8) -> "4,8" */
export const komma = (n: number, d = 1) => Number(n).toFixed(d).replace(".", ",");
/** Ganze Zahl oder eine Nachkommastelle, je nach Groesse. */
export const zahlKurz = (n: number) => (Math.abs(n) >= 10 ? String(Math.round(n)) : komma(n, 1));
const fGanz = new Intl.NumberFormat("de-CH", { maximumFractionDigits: 0 });
/** Ganze Zahl mit Schweizer Tausender-Apostroph: tausend(2140) -> "2’140" (Drehzahlen). */
export const tausend = (n: number) => fGanz.format(Math.round(n));

export const uhr = (z: Zeit | null | undefined) => (gueltig(z) ? fHM.format(alsDate(z)) : "–");
export const uhrSek = (z: Zeit | null | undefined) => (gueltig(z) ? fHMS.format(alsDate(z)) : "–");
/** «12.10.» */
export const tagKurz = (z: Zeit) => fTag.format(alsDate(z)).replace(/\.?$/, ".");
export const datumLang = (z: Zeit) => fDatum.format(alsDate(z));
export const wochentag = (z: Zeit) => fWt.format(alsDate(z)).replace(".", "");
export const tagSchluessel = (z: Zeit) => fYmd.format(alsDate(z));
export const stundeZurich = (z: Zeit) => Number(fStunde.format(alsDate(z)).slice(0, 2)) % 24;

/** «07:53» heute, «gestern 22:25», sonst «11.10., 17:00». */
export function zeitpunkt(z: Zeit | null | undefined, jetzt: number): string {
  if (!gueltig(z)) return "–";
  const t = alsDate(z);
  const heute = tagSchluessel(jetzt);
  if (tagSchluessel(t) === heute) return `heute ${uhr(t)}`;
  if (tagSchluessel(t) === tagSchluessel(jetzt - 86_400_000)) return `gestern ${uhr(t)}`;
  return `${tagKurz(t)}, ${uhr(t)}`;
}

/** Ohne «heute»-Praefix, fuer enge Stellen. */
export function zeitpunktKurz(z: Zeit | null | undefined, jetzt: number): string {
  if (!gueltig(z)) return "–";
  const t = alsDate(z);
  if (tagSchluessel(t) === tagSchluessel(jetzt)) return uhr(t);
  if (tagSchluessel(t) === tagSchluessel(jetzt - 86_400_000)) return `gestern ${uhr(t)}`;
  return `${tagKurz(t)}, ${uhr(t)}`;
}

/** «gerade eben», «vor 40 s», «vor 3 min», «vor 2 h», «vor 3 Tagen». */
export function alterText(sek: number | null | undefined): string {
  if (sek == null || !Number.isFinite(sek)) return "unbekannt";
  const s = Math.max(0, Math.round(sek));
  if (s < 5) return "gerade eben";
  if (s < 60) return `vor ${s} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 172_800) return `vor ${Math.round(s / 3600)} h`;
  return `vor ${Math.round(s / 86_400)} Tagen`;
}

/** Dauer ohne «vor»: «14 h», «3 Tage», «45 min». */
export function dauerText(sek: number): string {
  const s = Math.max(0, Math.round(sek));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 172_800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} Tage`;
}

// ---- Groessen ----
export const GIB = 1024 ** 3;
/** Binaer (Arbeits-/Grafikspeicher), Anzeige «GB». */
export const gbBin = (b: number) => b / GIB;
/** Dezimal (Platten/NAS): «533 GB», «8,0 TB», «2 TB» bei rund=true. */
export function groesseDez(b: number, rund = false): string {
  if (b >= 1e12) return rund ? `${Math.round(b / 1e12)} TB` : `${komma(b / 1e12, 1)} TB`;
  if (b >= 1e10) return `${Math.round(b / 1e9)} GB`;
  return `${komma(b / 1e9, 1)} GB`;
}
export const prozent = (teil: number, ganz: number) => (ganz > 0 ? Math.max(0, Math.min(100, (teil / ganz) * 100)) : 0);
