// Rechenkern Lohn — feste Regeln und Rundung (eine Stelle für alle Zahlen).
//
// Quellen: AAB EVENTLINE (Fassung 29.10.2026), ArG/ArGV 1, OR 329a,
// BV 110 Abs. 3, Art. 34d AHVV, Art. 13 UVV + Empfehlung 7/87 (Rev. 2019).

import type { AbzugArt } from "./typen";
import { monatIndex } from "./zeit";

/** Version des Kerns — steht in jeder Momentaufnahme.
 *  2026.11-2: Zusatzposten (Lohn, Rückerstattung, Spesen), Auszahlungsbetrag. */
export const KERN_VERSION = "2026.11-2";

/** Abzüge in Klartext (Lohnabrechnung, Auswahl Rückerstattung) — nie Code-Namen zeigen. */
export const ABZUG_KLARTEXT: Record<AbzugArt, string> = {
  ahv_iv_eo: "AHV/IV/EO",
  alv: "Arbeitslosenversicherung (ALV)",
  nbu: "Nichtberufsunfall (NBU)",
  bvg: "Pensionskasse (BVG)",
  ktg: "Krankentaggeld (KTG)",
  quellensteuer: "Quellensteuer",
};

/** Sonntag/Feiertag: Zuschlag bei vorübergehender Arbeit (bis 6 Tage je Kalenderjahr). */
export const SONNTAG_ZUSCHLAG_PCT = 50;
export const SONNTAG_MAX_JE_JAHR = 6;
/** Sonntag = Samstag 23:00 bis Sonntag 23:00 (Feiertage: Vortag 23 bis Feiertag 23). */
export const SONNTAG_BEGINN_VORTAG_STUNDE = 23;

/** Nacht 23:00–06:00: Zuschlag bis 24 Nächte je Kalenderjahr, danach Zeitzuschlag. */
export const NACHT_VON_STUNDE = 23;
export const NACHT_BIS_STUNDE = 6;
export const NACHT_ZUSCHLAG_PCT = 25;
export const NACHT_MAX_JE_JAHR = 24;
export const ZEITZUSCHLAG_PCT = 10;

/** Ferienzuschlag: 4 Wochen = 8,33 %, 5 Wochen (bis 20) = 10,64 %. */
export const FERIEN_PCT_ERWACHSEN = 8.33;
export const FERIEN_PCT_JUGEND = 10.64;
export const FERIEN_JUGEND_BIS_ALTER = 20;

/** 1. August (Art. 110 Abs. 3 BV) für Stundenlöhner: 0,39 % auf den Lohn. */
export const FEIERTAG_1AUG_PCT = 0.39;

/** Art. 34d AHVV: geringfügiger Lohn je Arbeitgeber und Jahr. */
export const AHV_GERINGFUEGIG_GRENZE = 2500;
/** Höchstbetrag versicherter Verdienst ALV und UVG je Jahr (seit 2016 unverändert). */
export const ALV_HOECHSTLOHN_JAHR = 148200;
export const UVG_HOECHSTLOHN_JAHR = 148200;

/** NBU: versichert ab Ø 8 h je Woche bei EVENTLINE (Art. 13 UVV). */
export const NBU_MIN_STUNDEN_PRO_WOCHE = 8;

/**
 * Die eine Rundungsregel: jeder Betrag (Position, Abzug, Beitrag) wird genau
 * einmal je Monat kaufmännisch auf 5 Rappen gerundet (halbe weg von null).
 * Mengen (Minuten) werden nie gerundet. Netto = Brutto − Summe der Abzüge.
 */
export function rundeChf(x: number): number {
  if (!Number.isFinite(x)) throw new Error(`rundeChf: ungültiger Betrag ${x}`);
  const s = x < 0 ? -1 : 1;
  const r = Math.round(Math.abs(x) * 20 + 1e-7) / 20;
  const v = Number((s * r).toFixed(2));
  return v === 0 ? 0 : v;
}

/** Betrag in 5-Rappen-Schritten? (Zusatzposten werden nie still gerundet.) */
export function istFuenfRappen(x: number): boolean {
  return Number.isFinite(x) && Math.abs(x * 20 - Math.round(x * 20)) < 1e-6;
}

/** Summe ohne Gleitkomma-Rauschen (auf Rappen). */
export function summeChf(werte: number[]): number {
  const v = Number(werte.reduce((a, b) => a + b, 0).toFixed(2));
  return v === 0 ? 0 : v;
}

/**
 * Ferienzuschlag nach Alter: 10,64 % bis und mit dem Monat, in dem das
 * 20. Altersjahr vollendet wird (20. Geburtstag), danach 8,33 %.
 */
export function ferienPctNachAlter(geburtsdatum: string, jahr: number, monat: number): number {
  const [gj, gm] = geburtsdatum.split("-").map(Number);
  return monatIndex(jahr, monat) <= monatIndex(gj + FERIEN_JUGEND_BIS_ALTER, gm)
    ? FERIEN_PCT_JUGEND
    : FERIEN_PCT_ERWACHSEN;
}

/** Prozent fürs Auge: 8.33 → "8,33 %". */
export function fmtProzent(p: number): string {
  return `${p.toFixed(2).replace(".", ",")} %`;
}
