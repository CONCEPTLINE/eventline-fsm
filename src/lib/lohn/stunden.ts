// Gestempelte Minuten je Lohnmonat — dieselbe Regel wie der Rechenkern
// (src/lib/lohn/kern/verteilung.ts, verteile): überlappende Stempel einer Person
// zählen einmal (vereinigt), offene Stempel (ohne Ende) zählen nicht, jede Minute
// gehört zum lokalen Kalendertag (Europe/Zurich), angefangene Minuten zählen ganz.
// Trust flow holt dieselben Stempel über /api/flow/stempel und rechnet damit.
//
// Verwendet von «Lohn» (/api/hr/mein-lohn) und «Stempelzeiten › Prüfen»
// (/api/hr/stempel-pruefung). Rein (kein Server, keine DB) — Tests: stunden.test.ts.

import { verteile } from "./kern/verteilung";
import type { Stempel } from "./kern/typen";

/** Minuten je Monat «YYYY-MM» (nur Monate mit Minuten > 0). */
export function minutenJeMonat(stempel: Stempel[]): Map<string, number> {
  const out = new Map<string, number>();
  const { tage } = verteile(stempel, null, new Map());
  for (const t of tage.values()) {
    if (t.minuten <= 0) continue;
    const m = t.datum.slice(0, 7);
    out.set(m, (out.get(m) ?? 0) + t.minuten);
  }
  return out;
}

/** UTC-Grenzen, die alle Stempel eines Kalenderjahrs (Ortszeit) sicher enthalten:
 *  Beginn ab 2 Tage vor Neujahr (lange Stempel aus dem Dezember), bis 1 Tag nach Silvester. */
export function jahrAbfrageGrenzen(jahr: number): { von: string; bis: string } {
  return {
    von: new Date(Date.UTC(jahr - 1, 11, 30)).toISOString(),
    bis: new Date(Date.UTC(jahr + 1, 0, 2)).toISOString(),
  };
}
