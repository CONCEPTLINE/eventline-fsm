// Prognosen (BVG-Ampel, «Mein Monat», 3-Monats-Vorschau) — mit DEMSELBEN
// Rechenkern wie die Abrechnung: geplante Termine werden wie Stempel
// behandelt (Lohn tageweise, Sonntag/Nacht, 1. August, Ferienzuschlag).

import type { Stempel } from "./kern";

export interface Termin {
  start_time: string;
  end_time: string | null;
}

/** Termine als Stempel (ohne Ende → keine Dauer, zählt nicht). */
export function termineAlsStempel(termine: Termin[], abMs?: number): Stempel[] {
  const out: Stempel[] = [];
  for (const t of termine) {
    if (!t.end_time) continue;
    const s = new Date(t.start_time).getTime();
    const e = new Date(t.end_time).getTime();
    if (!(e > s)) continue;
    if (abMs != null && s < abMs) continue;
    out.push({ start: t.start_time, ende: t.end_time });
  }
  return out;
}

/** Puffer auf geplante Stunden (ungeplante Verlängerungen, spontane Einsätze). */
export const PROGNOSE_PUFFER = 1.2;

/** Ist + Plan mit Puffer. */
export function mitPuffer(ist: number, mitPlan: number): number {
  return ist + Math.max(0, mitPlan - ist) * PROGNOSE_PUFFER;
}

/** Ampel gegenüber der BVG-Eintrittsschwelle. */
export function forecastStatus(chf: number, threshold: number): "ok" | "warn" | "crit" {
  const ratio = chf / threshold;
  if (ratio >= 0.95) return "crit";
  if (ratio >= 0.7) return "warn";
  return "ok";
}

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

export function monthRange(year: number, month: number): { start: string; end: string; label: string } {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end, label: `${MONATE[month - 1]} ${year}` };
}
