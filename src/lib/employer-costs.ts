/**
 * Sätze für Kosten-PROGNOSEN (Auftrags-Personalkosten, Standort-Rapport,
 * Plausibilität im Lohn-Editor). Die Lohnabrechnung selbst rechnet der
 * Rechenkern (src/lib/lohn/kern) — diese Hilfen nutzen dieselbe Abbildung
 * der Datenbank (src/lib/lohn/daten.ts) und dieselbe Satz-Wahl
 * (firmensatzAm). Keine Ersatzsätze: fehlt eine Zeile oder ein Satz,
 * wird ein Fehler geworfen (Phase 2, «fehlende Sätze = Fehler»).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { todayLocalIso } from "@/lib/swiss-time";
import { firmensatzAm, type Firmensatz } from "@/lib/lohn/kern";
import { ladeFirmensaetze } from "@/lib/lohn/daten";

export interface LohnPctSet {
  // Mitarbeiter-Abzuege (% vom Brutto)
  ahvIvEoPct: number;
  alvPct: number;
  nbuPct: number;
  bvgPct: number;
  ktgPct: number;
  quellensteuerPct: number;
  // Arbeitgeber-Anteil (% vom Brutto)
  employerAhvPct: number;
  employerAlvPct: number;
  employerFakPct: number;
  employerBuPct: number;
  employerBvgPct: number;
  employerVerwaltungPct: number;
}

/** Summe der 6 AG-Pcts (= Arbeitgeber-Anteil als % vom Brutto). */
export function sumEmployerPct(s: LohnPctSet): number {
  return s.employerAhvPct + s.employerAlvPct + s.employerFakPct
       + s.employerBuPct + s.employerBvgPct + s.employerVerwaltungPct;
}

/** Summe der 6 AN-Pcts (= Mitarbeiter-Abzuege als % vom Brutto). */
export function sumEmployeePct(s: LohnPctSet): number {
  return s.ahvIvEoPct + s.alvPct + s.nbuPct + s.bvgPct + s.ktgPct + s.quellensteuerPct;
}

function ausFirmensatz(f: Firmensatz): LohnPctSet {
  return {
    ahvIvEoPct: f.an.ahvIvEo, alvPct: f.an.alv, nbuPct: f.an.nbu, bvgPct: f.an.bvg, ktgPct: f.an.ktg, quellensteuerPct: f.an.quellensteuer,
    employerAhvPct: f.ag.ahvIvEo, employerAlvPct: f.ag.alv, employerFakPct: f.ag.fak, employerBuPct: f.ag.bu,
    employerBvgPct: f.ag.bvg, employerVerwaltungPct: f.ag.verwaltung,
  };
}

function pruefe(s: LohnPctSet, wo: string): LohnPctSet {
  for (const [k, v] of Object.entries(s)) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${wo}: Satz ${k} fehlt`);
  }
  return s;
}

/** Liefert die effektiven Pcts fuer eine Compensation-Row: Standard → die
 *  Firmensätze, eigene Sätze → die Spalten der Zeile (fehlender Satz = Fehler). */
export function effectivePcts(comp: PctComp | null | undefined, defaults: LohnPctSet): LohnPctSet {
  if (!comp || comp.uses_standard_lohn !== false) return defaults;
  const n = (v: unknown): number => (v == null || v === "" ? NaN : Number(v));
  return pruefe({
    ahvIvEoPct: n(comp.ahv_iv_eo_pct),
    alvPct: n(comp.alv_pct),
    nbuPct: n(comp.nbu_pct),
    bvgPct: n(comp.bvg_pct),
    ktgPct: n(comp.ktg_pct),
    quellensteuerPct: n(comp.quellensteuer_pct),
    employerAhvPct: n(comp.employer_ahv_pct),
    employerAlvPct: n(comp.employer_alv_pct),
    employerFakPct: n(comp.employer_fak_pct),
    employerBuPct: n(comp.employer_bu_pct),
    employerBvgPct: n(comp.employer_bvg_pct),
    employerVerwaltungPct: n(comp.employer_verwaltung_pct),
  }, "Lohnzeile mit eigenen Sätzen");
}

/** Minimaler Row-Shape den effectivePcts braucht. */
export interface PctComp {
  uses_standard_lohn?: boolean | null;
  ahv_iv_eo_pct?: number | string | null;
  alv_pct?: number | string | null;
  nbu_pct?: number | string | null;
  bvg_pct?: number | string | null;
  ktg_pct?: number | string | null;
  quellensteuer_pct?: number | string | null;
  employer_ahv_pct?: number | string | null;
  employer_alv_pct?: number | string | null;
  employer_fak_pct?: number | string | null;
  employer_bu_pct?: number | string | null;
  employer_bvg_pct?: number | string | null;
  employer_verwaltung_pct?: number | string | null;
}

/** Firmensätze, die am Datum gelten (ohne Datum: heute). Fehlt eine Zeile
 *  oder ein Satz → Fehler, keine eingebauten Ersatzwerte. */
export async function loadLohnDefaults(client: SupabaseClient, asOf?: string): Promise<LohnPctSet> {
  const datum = asOf ?? todayLocalIso();
  const f = firmensatzAm(await ladeFirmensaetze(client), datum);
  if (!f) throw new Error(`Keine Firmensätze gültig am ${datum}`);
  return pruefe(ausFirmensatz(f), `Firmensätze ab ${f.gueltigAb}`);
}
