/**
 * Häuser-Pipeline (Vertrieb neu, Leo 09.11.2026) — reine Logik ohne React
 * und ohne DB, damit sie getestet werden kann (haeuser.test.ts):
 * Stufen mit Rang und Farbton, Gebietsfilter, Suche, Sortierung, Zählung,
 * Takt pro Woche und die Prüftermine aus dem Plan bis Dezember 2027.
 *
 * Gefiltert wird im Browser: die Häuser sind eine kurze, kuratierte Liste
 * (heute 34, auf Jahre hinaus wenige hundert) und werden einmal ganz
 * geladen (HAEUSER_MAX). Wächst sie darüber, gehört die Filterung in die DB.
 */

import type { Ton } from "@/components/dashboard/karte";
import { plusTage } from "@/lib/swiss-time";
import type { HausStufe, HausVerlauf, VertriebRaum } from "@/types/vertrieb";

/** Obergrenze beim Laden — darüber Hinweis statt stillem Abschneiden. */
export const HAEUSER_MAX = 1000;

/** Obergrenze Erstmails pro Woche (Entscheid Leo 9.11.2026). */
export const MAILS_PRO_WOCHE_MAX = 10;

export interface StufeInfo {
  key: HausStufe;
  label: string;
  /** Reihenfolge in der Pipeline; -1 = ausserhalb (Absage, Pause). */
  rang: number;
  ton: Ton;
  /** Punkt-/Balkenfarbe (Tailwind-Klasse, hell + dunkel). */
  farbe: string;
}

export const STUFEN: StufeInfo[] = [
  { key: "recherche", label: "Recherche", rang: 0, ton: "neutral", farbe: "bg-foreground/25" },
  { key: "bedarf", label: "Bedarf belegt", rang: 1, ton: "neutral", farbe: "bg-foreground/60" },
  { key: "anruf", label: "Anruf geplant", rang: 2, ton: "amber", farbe: "bg-amber-500" },
  { key: "angeschrieben", label: "Angeschrieben", rang: 3, ton: "rot", farbe: "bg-red-600 dark:bg-red-500" },
  { key: "gespraech", label: "Im Gespräch", rang: 4, ton: "gruen", farbe: "bg-blue-600 dark:bg-blue-500" },
  { key: "pilot", label: "Pilot", rang: 5, ton: "gruen", farbe: "bg-purple-600 dark:bg-purple-500" },
  { key: "partner", label: "Partner", rang: 6, ton: "gruen", farbe: "bg-emerald-600 dark:bg-emerald-500" },
];

const AUSSERHALB: StufeInfo[] = [
  { key: "absage", label: "Absage", rang: -1, ton: "neutral", farbe: "bg-foreground/20" },
  { key: "pause", label: "Pause", rang: -1, ton: "neutral", farbe: "bg-foreground/20" },
];

const STUFE_MAP = new Map<HausStufe, StufeInfo>([...STUFEN, ...AUSSERHALB].map((s) => [s.key, s]));

export function stufeInfo(stufe: HausStufe): StufeInfo {
  return STUFE_MAP.get(stufe) ?? STUFEN[0];
}

/** Alle Stufen inkl. Absage/Pause (Auswahlfeld im Profil). */
export const ALLE_STUFEN: StufeInfo[] = [...STUFEN, ...AUSSERHALB];

/** Aktiv = in der Pipeline (nicht Absage, nicht Pause). */
export function istAktiv(h: Pick<VertriebRaum, "stufe">): boolean {
  return stufeInfo(h.stufe).rang >= 0;
}

/** Angeschrieben oder weiter. */
export function istAngeschrieben(h: Pick<VertriebRaum, "stufe">): boolean {
  return stufeInfo(h.stufe).rang >= 3;
}

export type GebietFilter = "alle" | "Basel-Stadt" | "Baselland" | "Fricktal" | "weitere";

export const GEBIET_FILTER: { key: GebietFilter; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "Basel-Stadt", label: "Basel-Stadt" },
  { key: "Baselland", label: "Baselland" },
  { key: "Fricktal", label: "Fricktal" },
  { key: "weitere", label: "Weitere" },
];

const HAUPTGEBIETE = new Set(["Basel-Stadt", "Baselland", "Fricktal"]);

export function istGebietFilter(v: string | null): v is GebietFilter {
  return GEBIET_FILTER.some((g) => g.key === v);
}

/** «Weitere» = alles ausserhalb der drei Hauptgebiete (Ring 2, Solothurn Nord …). */
export function imGebiet(h: Pick<VertriebRaum, "gebiet">, filter: GebietFilter): boolean {
  if (filter === "alle") return true;
  if (filter === "weitere") return !HAUPTGEBIETE.has(h.gebiet ?? "");
  return h.gebiet === filter;
}

/** Suche in Name, Ort und Gruppe — ohne Gross/Klein und ohne Akzente. */
export function passtZurSuche(h: Pick<VertriebRaum, "name" | "ort" | "gruppe">, suche: string): boolean {
  const q = normalisiere(suche);
  if (!q) return true;
  return normalisiere(`${h.name} ${h.ort ?? ""} ${h.gruppe ?? ""}`).includes(q);
}

function normalisiere(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export type StufeFilter = HausStufe | "alle";

export function istStufeFilter(v: string | null): v is StufeFilter {
  return v === "alle" || STUFEN.some((s) => s.key === v);
}

/** Aktive Häuser nach Gebiet und Suche (vor dem Stufen-Filter → Kachel-Zahlen). */
export function filtereHaeuser<T extends VertriebRaum>(haeuser: T[], gebiet: GebietFilter, suche: string): T[] {
  return haeuser.filter((h) => istAktiv(h) && imGebiet(h, gebiet) && passtZurSuche(h, suche));
}

/** Anzahl je Stufe (nur Pipeline-Stufen) plus «alle». */
export function zaehleStufen(haeuser: Pick<VertriebRaum, "stufe">[]): Record<StufeFilter, number> {
  const z = { alle: 0 } as Record<StufeFilter, number>;
  for (const s of STUFEN) z[s.key] = 0;
  for (const h of haeuser) {
    if (!istAktiv(h)) continue;
    z.alle++;
    z[h.stufe]++;
  }
  return z;
}

/** Weiteste Stufe zuerst, dann Prio A vor B, dann nächster Schritt
 *  (früheres Datum zuerst, ohne Datum ans Ende), dann Name. */
export function sortiereHaeuser<T extends Pick<VertriebRaum, "stufe" | "prio" | "datum" | "name">>(haeuser: T[]): T[] {
  return [...haeuser].sort((a, b) =>
    stufeInfo(b.stufe).rang - stufeInfo(a.stufe).rang
    || a.prio.localeCompare(b.prio)
    || (a.datum ?? "9999-12-31").localeCompare(b.datum ?? "9999-12-31")
    || a.name.localeCompare(b.name, "de-CH"),
  );
}

/** Spalten der Tafel: Pilot und Partner teilen sich die letzte Spalte. */
export const TAFEL_SPALTEN: { key: string; label: string; stufen: HausStufe[] }[] = [
  { key: "recherche", label: "Recherche", stufen: ["recherche"] },
  { key: "bedarf", label: "Bedarf belegt", stufen: ["bedarf"] },
  { key: "anruf", label: "Anruf geplant", stufen: ["anruf"] },
  { key: "angeschrieben", label: "Angeschrieben", stufen: ["angeschrieben"] },
  { key: "gespraech", label: "Im Gespräch", stufen: ["gespraech"] },
  { key: "partner", label: "Pilot / Partner", stufen: ["pilot", "partner"] },
];

/** ISO-Kalenderwoche eines Date-Only-Strings (YYYY-MM-DD). */
export function isoWoche(datum: string): { jahr: number; woche: number } {
  const [y, m, d] = datum.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const tag = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - tag);
  const jahrStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { jahr: t.getUTCFullYear(), woche: Math.ceil(((t.getTime() - jahrStart.getTime()) / 86_400_000 + 1) / 7) };
}

/** Montag (YYYY-MM-DD) der Woche, in der `datum` liegt. */
export function wochenMontag(datum: string): string {
  const [y, m, d] = datum.split("-").map(Number);
  return plusTage(datum, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
}

/** Erstmails an Häuser pro Woche: `wochen` Wochen ab der Woche von `start`.
 *  Gezählt wird je Haus nur die ERSTE Mail (Erstkontakt), nicht jede Antwort. */
export function erstmailsProWoche(
  verlauf: Pick<HausVerlauf, "haus_id" | "datum" | "art">[],
  start: string,
  wochen: number,
): { montag: string; kw: number; anzahl: number }[] {
  const erste = new Map<string, string>();
  for (const v of verlauf) {
    if (v.art !== "mail") continue;
    const alt = erste.get(v.haus_id);
    if (!alt || v.datum < alt) erste.set(v.haus_id, v.datum);
  }
  const zaehler = new Map<string, number>();
  for (const d of erste.values()) {
    const mo = wochenMontag(d);
    zaehler.set(mo, (zaehler.get(mo) ?? 0) + 1);
  }
  const ergebnis: { montag: string; kw: number; anzahl: number }[] = [];
  const ersterMontag = wochenMontag(start);
  for (let i = 0; i < wochen; i++) {
    const mo = plusTage(ersterMontag, i * 7);
    ergebnis.push({ montag: mo, kw: isoWoche(mo).woche, anzahl: zaehler.get(mo) ?? 0 });
  }
  return ergebnis;
}

/** Prüftermine aus dem Plan bis Dezember 2027 (Fassung 2, ~/reports/
 *  «EVENTLINE Plan bis Dezember 2027.md»). Ändert sich der Plan, hier
 *  nachführen — bewusst Konstante, keine Tabelle (ändert sich selten). */
export const PRUEFTERMINE: { titel: string; datum: string; hart?: boolean }[] = [
  { titel: "Zwischenbilanz", datum: "2026-12-04" },
  { titel: "Gate G1", datum: "2026-12-31" },
  { titel: "Gate G2", datum: "2027-03-31" },
  { titel: "Harter Stopp", datum: "2027-06-30", hart: true },
  { titel: "Gate G3", datum: "2027-09-30" },
  { titel: "Gate G4", datum: "2027-12-15" },
];

/** Ziel 2027 aus dem Plan: Aufträge über neue Häuser. */
export const ZIEL_AUFTRAEGE_2027 = 40;

/** Tage zwischen zwei Date-Only-Strings (b − a). */
export function tageZwischen(a: string, b: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

export type AnrufErgebnis = "termin" | "rueckruf" | "nicht_erreicht" | "kein_bedarf";

export const ANRUF_ERGEBNISSE: { key: AnrufErgebnis; label: string; kasten: string }[] = [
  { key: "termin", label: "Termin vereinbart", kasten: "kasten-green" },
  { key: "rueckruf", label: "Rückruf in 7 Tagen", kasten: "kasten-amber" },
  { key: "nicht_erreicht", label: "Nicht erreicht", kasten: "kasten-muted" },
  { key: "kein_bedarf", label: "Kein Bedarf", kasten: "kasten-muted" },
];

export function istAnrufErgebnis(v: unknown): v is AnrufErgebnis {
  return ANRUF_ERGEBNISSE.some((e) => e.key === v);
}

/** Was ein erfasster Anruf am Haus ändert: Verlaufseintrag, neue Stufe
 *  (oder unverändert) und der nächste Schritt (Datum + Aufgabe → Kalender). */
export function anrufFolgen(ergebnis: AnrufErgebnis, heute: string, stufeVorher: HausStufe): {
  titel: string;
  text: string;
  ton: "gruen" | "amber" | "neutral";
  stufe: HausStufe;
  datum: string | null;
  aufgabe: string | null;
} {
  const plus = (n: number) => plusTage(heute, n);
  switch (ergebnis) {
    case "termin":
      return {
        titel: "Anruf · Termin vereinbart", text: "Gespräch oder Augenschein vereinbart.", ton: "gruen",
        // Nie rückwärts: ein Pilot- oder Partnerhaus bleibt, was es ist.
        stufe: stufeInfo(stufeVorher).rang >= stufeInfo("gespraech").rang ? stufeVorher : "gespraech",
        datum: null, aufgabe: "Termin eintragen und vorbereiten",
      };
    case "rueckruf":
      return { titel: "Anruf · Rückruf vereinbart", text: "In einer Woche nochmals melden.", ton: "amber", stufe: stufeVorher, datum: plus(7), aufgabe: "Rückruf wie vereinbart" };
    case "nicht_erreicht":
      return { titel: "Anruf · nicht erreicht", text: "Niemand erreicht.", ton: "neutral", stufe: stufeVorher, datum: plus(2), aufgabe: "Zweiter Anrufversuch" };
    case "kein_bedarf":
      return { titel: "Anruf · kein Bedarf", text: "Haus verzichtet. Nicht mehr anfragen.", ton: "neutral", stufe: "absage", datum: null, aufgabe: null };
  }
}

/** Verteilung je Gebiet für die Auswertung (Weitere zusammengefasst). */
export function verteilungNachGebiet(haeuser: Pick<VertriebRaum, "stufe" | "gebiet">[]) {
  const gruppen: { label: string; filter: GebietFilter }[] = [
    { label: "Basel-Stadt", filter: "Basel-Stadt" },
    { label: "Baselland", filter: "Baselland" },
    { label: "Fricktal", filter: "Fricktal" },
    { label: "Weitere", filter: "weitere" },
  ];
  return gruppen.map((g) => {
    const im = haeuser.filter((h) => istAktiv(h) && imGebiet(h, g.filter));
    return {
      label: g.label,
      gesamt: im.length,
      angeschrieben: im.filter(istAngeschrieben).length,
      vorbereitet: im.filter((h) => h.stufe === "bedarf" || h.stufe === "anruf").length,
      recherche: im.filter((h) => h.stufe === "recherche").length,
    };
  });
}
