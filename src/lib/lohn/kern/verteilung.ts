// Stempel minutengenau auf lokale Kalendertage (Europe/Zurich) verteilen.
//
// Regeln:
//   - Überlappende Stempel einer Person zählen jede Minute nur einmal.
//   - Offene Stempel (ohne Ende) zählen nicht.
//   - Angefangene Minuten zählen ganz (jeLokalerStunde).

import type { Stempel } from "./typen";
import { jeLokalerStunde, vereinige, zuMs } from "./zeit";

/** Gestempelte Minuten je lokalem Kalendertag «YYYY-MM-DD». */
export function minutenJeTag(stempel: Stempel[]): Map<string, number> {
  const roh: { start: number; ende: number }[] = [];
  for (const s of stempel) {
    if (s.ende == null) continue;
    roh.push({ start: zuMs(s.start), ende: zuMs(s.ende) });
  }
  const { intervalle } = vereinige(roh);
  const tage = new Map<string, number>();
  for (const iv of intervalle) {
    jeLokalerStunde(iv.start, iv.ende, (datum, _stunde, minuten) => {
      tage.set(datum, (tage.get(datum) ?? 0) + minuten);
    });
  }
  return tage;
}
