/**
 * Vertrieb › Kampagnen — Status, Kennzahlen und Datumsanzeige an EINER
 * Stelle, damit Liste, Detail und Filter dieselbe Sprache sprechen (§3).
 * Begriffe bewusst einfach (Leo ist kein Entwickler).
 */

import { ZRH_TZ } from "@/lib/swiss-time";
import type { KampagneStatus } from "@/types/vertrieb";

export const KAMPAGNE_STATUS: Record<KampagneStatus, { label: string; farbe: string }> = {
  offen:        { label: "Offen",            farbe: "bg-gray-100 text-gray-700 dark:bg-gray-500/20 dark:text-gray-300" },
  geplant:      { label: "Geplant",          farbe: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300" },
  gesendet:     { label: "Angeschrieben",    farbe: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300" },
  geantwortet:  { label: "Antwort erhalten", farbe: "bg-green-100 text-green-800 dark:bg-green-500/25 dark:text-green-200" },
  termin:       { label: "Termin",           farbe: "bg-teal-100 text-teal-800 dark:bg-teal-500/25 dark:text-teal-200" },
  offerte:      { label: "Offerte",          farbe: "bg-teal-100 text-teal-800 dark:bg-teal-500/25 dark:text-teal-200" },
  auftrag:      { label: "Auftrag",          farbe: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-white" },
  kein_bedarf:  { label: "Kein Interesse",   farbe: "bg-red-50 text-red-600/80 dark:bg-red-500/10 dark:text-red-300/70" },
  unzustellbar: { label: "Nicht zustellbar", farbe: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
  anrufen:      { label: "Anrufen",          farbe: "bg-amber-100 text-amber-800 dark:bg-amber-500/25 dark:text-amber-200" },
};

/** Anzeige statt «Angeschrieben», wenn Nachfassen fällig ist (nachfassen.ts). */
export const NACHFASSEN_BADGE = {
  label: "Nachfassen",
  farbe: "bg-orange-100 text-orange-800 dark:bg-orange-500/25 dark:text-orange-200",
} as const;

/** Reihenfolge im Status-Auswahlfeld (Ablauf einer Akquise). */
export const STATUS_REIHENFOLGE: KampagneStatus[] = [
  "offen", "geplant", "gesendet", "geantwortet", "anrufen",
  "termin", "offerte", "auftrag", "kein_bedarf", "unzustellbar",
];

export function istKampagneStatus(x: unknown): x is KampagneStatus {
  return typeof x === "string" && x in KAMPAGNE_STATUS;
}

/**
 * Kennzahlen im Kopf. Jede Kennzahl ist eine Menge von Status — Klick
 * filtert genau auf diese Menge, Zahl und Treffer stimmen also immer überein.
 * «Angeschrieben» und «Antworten» zählen kumuliert: wer schon einen Termin
 * hat, wurde auch angeschrieben und hat auch geantwortet.
 * `nurWennDa`: erscheint nur, wenn die Zahl > 0 ist.
 */
export const KENNZAHLEN = [
  { key: "alle",          label: "Kontakte",         status: null },
  { key: "geplant",       label: "Geplant",          status: ["geplant"] },
  { key: "angeschrieben", label: "Angeschrieben",    status: ["gesendet", "geantwortet", "termin", "offerte", "auftrag", "kein_bedarf"] },
  { key: "antworten",     label: "Antworten",        status: ["geantwortet", "termin", "offerte", "auftrag", "kein_bedarf"] },
  // Nachfassen ist zeitabhängig (nachfassen.ts) — Zahl kommt eigens aus der DB.
  { key: "nachfassen",    label: "Nachfassen",       status: ["gesendet"], nurWennDa: true },
  { key: "termin",        label: "Termine",          status: ["termin"] },
  { key: "auftrag",       label: "Aufträge",         status: ["auftrag"] },
  { key: "anrufen",       label: "Anrufen",          status: ["anrufen"], nurWennDa: true },
  { key: "unzustellbar",  label: "Nicht zustellbar", status: ["unzustellbar"], nurWennDa: true },
] as const satisfies readonly {
  key: string;
  label: string;
  status: readonly KampagneStatus[] | null;
  nurWennDa?: boolean;
}[];

export type KennzahlKey = (typeof KENNZAHLEN)[number]["key"];

/** Zusätzliche Filter-Werte (Gruppen), die keine einzelnen Status sind. */
const GRUPPEN_FILTER = { angeschrieben: "Alle angeschriebenen", antworten: "Alle mit Antwort", nachfassen: "Nachfassen fällig" } as const;

/** Filter-Wert der URL (`?status=`): «alle», ein Status oder eine Gruppe. */
export type StatusFilter = "alle" | KampagneStatus | keyof typeof GRUPPEN_FILTER;

export function istStatusFilter(x: unknown): x is StatusFilter {
  return x === "alle" || istKampagneStatus(x) || (typeof x === "string" && x in GRUPPEN_FILTER);
}

/** Welche Status ein Filter-Wert umfasst (null = alle). */
export function statusMenge(f: StatusFilter): readonly KampagneStatus[] | null {
  if (f === "alle") return null;
  if (istKampagneStatus(f)) return [f];
  return KENNZAHLEN.find((k) => k.key === f)?.status ?? null;
}

/** Nur Kontakte, bei denen Nachfassen fällig ist? */
export function nurNachfassen(f: StatusFilter): boolean {
  return f === "nachfassen";
}

/** Filter-Wert, auf den ein Klick auf eine Kennzahl springt: der Schlüssel
 *  selbst — er ist «alle», ein Einzel-Status oder eine Gruppe. */
export function filterFuerKennzahl(key: KennzahlKey): StatusFilter {
  return key;
}

/** Einträge fürs Status-Auswahlfeld. */
export function statusFilterOptionen(): { id: StatusFilter; label: string }[] {
  return [
    { id: "alle", label: "Alle Status" },
    { id: "antworten", label: GRUPPEN_FILTER.antworten },
    { id: "nachfassen", label: GRUPPEN_FILTER.nachfassen },
    { id: "angeschrieben", label: GRUPPEN_FILTER.angeschrieben },
    ...STATUS_REIHENFOLGE.map((s) => ({ id: s as StatusFilter, label: KAMPAGNE_STATUS[s].label })),
  ];
}

/** Summen je Kennzahl aus den Zählern je Status (+ fällige Nachfass-Kontakte). */
export function kennzahlWerte(jeStatus: Partial<Record<KampagneStatus, number>>, nachfassen: number): Record<KennzahlKey, number> {
  const summe = (menge: readonly KampagneStatus[] | null) =>
    menge === null
      ? Object.values(jeStatus).reduce((a, b) => a + (b ?? 0), 0)
      : menge.reduce((a, s) => a + (jeStatus[s] ?? 0), 0);
  const werte = Object.fromEntries(KENNZAHLEN.map((k) => [k.key, summe(k.status)])) as Record<KennzahlKey, number>;
  werte.nachfassen = nachfassen;
  return werte;
}

// ── Datum (§4: immer Europe/Zurich) ─────────────────────────────────────

const DATUM = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, day: "2-digit", month: "2-digit", year: "2-digit" });
const DATUM_ZEIT = new Intl.DateTimeFormat("de-CH", {
  timeZone: ZRH_TZ, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit",
});
const DATUM_LANG = new Intl.DateTimeFormat("de-CH", {
  timeZone: ZRH_TZ, weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});

/** «29.10.26» */
export function datumKurz(iso: string): string {
  return DATUM.format(new Date(iso));
}
/** «29.10.26, 14:05» */
export function datumZeit(iso: string): string {
  return DATUM_ZEIT.format(new Date(iso));
}
/** «Do., 29.10.2026, 14:05» — für das Detail. */
export function datumLang(iso: string): string {
  return DATUM_LANG.format(new Date(iso));
}
